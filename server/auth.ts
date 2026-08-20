// 계정과 세션.
//
// 신원의 근거가 "이 브라우저"(realtime/identity.ts의 clientKey)에서 "이 계정"으로
// 올라온다. DM의 수신자, 대화 기록의 작성자, 읽음 표시의 주체가 전부 여기의
// user id를 가리키므로, 메신저의 모든 영속 데이터가 이 파일 위에 선다.
//
// 라이브러리를 안 쓴 이유: 필요한 게 비밀번호 해시(node:crypto의 scrypt),
// 무작위 토큰(randomBytes), 쿠키 문자열 조립뿐이다. passport 같은 프레임워크는
// 전략·세션 스토어·미들웨어 계층을 통째로 들고 오는데, 그 대부분이 여기선
// 쓰이지 않는 무게다. 의존성 하나는 공짜가 아니다(버전·취약점·타입을 따라다녀야
// 한다) — imagetype.ts가 magic bytes를 직접 읽는 것과 같은 판단.

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import NodeCache from "node-cache";
import type { Request, RequestHandler, Response } from "express";
import { readPool, writePool } from "./db.ts";

// --- 비밀번호 ---
//
// scrypt인 이유: 단순 sha256은 GPU로 초당 수십억 번 시도할 수 있어 유출 시
// 짧은 비밀번호가 그대로 뚫린다. scrypt는 일부러 메모리를 많이 쓰게 설계돼
// 대량 시도가 비싸다. bcrypt/argon2도 같은 목적이지만 그건 의존성이 필요하고,
// scrypt는 Node에 내장돼 있다.

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN).toString("hex");
  // 소금을 해시와 같이 보관한다. 소금은 비밀이 아니다 — 목적은 "같은 비밀번호가
  // 같은 해시가 되는 것"을 막아 무지개표(사전) 공격을 무력화하는 것뿐이다.
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  // 게스트 계정의 password_hash는 빈 값이다(schema.sql). 어떤 비밀번호로도
  // 로그인될 수 없어야 하므로 모양이 아니면 즉시 거짓.
  if (!salt || !expected) return false;

  const actual = scryptSync(password, salt, KEY_LEN).toString("hex");
  // === 비교는 다른 글자가 나오는 순간 멈춰서, 응답 시간이 "앞에서 몇 글자나
  // 맞았는지"를 흘린다. 길이가 같은 hex 두 개를 상수 시간으로 비교한다.
  //
  // 길이를 먼저 보는 이유: timingSafeEqual은 길이가 다르면 false가 아니라
  // RangeError를 던진다. 그러면 이 함수는 "안 맞는다"고 답하는 대신 예외로
  // 빠져나가고, 부르는 쪽(routes/auth.ts)의 401이 통째로 500이 된다.
  // 상수 시간 비교를 쓴 목적 자체가 무너지는 자리다 — 상태 코드가 갈리는 순간
  // 응답 시간보다 훨씬 큰 신호로 "그 계정이 있느냐"가 새어나간다.
  // 길이 비교 자체는 비밀을 흘리지 않는다. 제대로 만든 해시는 언제나
  // KEY_LEN*2 자리라 길이가 다르다는 건 "저장된 값이 해시 모양이 아니다"는
  // 뜻일 뿐, 비밀번호가 몇 글자나 맞았는지와는 무관하다.
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

// 없는 아이디로 로그인을 시도했을 때 시간을 맞추려고 검증시키는 더미 해시.
//
// 진짜 해시와 모양이 같아야 한다(소금 + KEY_LEN*2 자리 hex). 모양이 다르면
// 검증 경로가 도중에 갈라져서 — 앞의 길이 검사에 먼저 걸리거나, 그 전의
// 모양 검사에서 scrypt를 아예 건너뛰거나 — 있는 아이디와 없는 아이디의
// 응답 시간이 달라진다. 그러면 로그인 화면이 아이디 수집기가 된다.
// 여기 두는 이유는 해시 모양을 아는 곳이 이 파일 하나여야 하기 때문이다
// (KEY_LEN을 바꾸면 이 값도 함께 따라온다).
export const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(KEY_LEN * 2)}`;

// --- 사용자 ---

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isGuest: boolean;
}

// pg의 query<R>가 요구하는 "컬럼명 → 값" 모양 (rag/types.ts의 type 주석과 같은 이유)
type UserRow = {
  id: string;
  username: string;
  display_name: string;
  is_guest: boolean;
};

function toUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isGuest: row.is_guest,
  };
}

export async function createUser(
  username: string,
  passwordHash: string,
  displayName: string,
  isGuest: boolean
): Promise<SessionUser> {
  const { rows } = await writePool.query<UserRow>(
    `insert into users (id, username, password_hash, display_name, is_guest)
     values ($1, $2, $3, $4, $5)
     returning id, username, display_name, is_guest`,
    [randomUUID(), username, passwordHash, displayName, isGuest]
  );
  const row = rows[0];
  if (!row) throw new Error("사용자 생성에 실패했습니다.");
  return toUser(row);
}

export async function findUserByUsername(
  username: string
): Promise<(SessionUser & { passwordHash: string }) | null> {
  const { rows } = await writePool.query<UserRow & { password_hash: string }>(
    `select id, username, display_name, is_guest, password_hash
       from users where username = $1`,
    [username]
  );
  const row = rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

// --- 세션 ---
//
// 토큰은 httpOnly 쿠키로만 오간다. JS가 못 읽으므로 XSS가 나도 토큰 자체는
// 훔칠 수 없다(그 브라우저에서 요청을 보내는 것까지는 못 막는다 — 그건
// sameSite가 다른 사이트발 요청을 거르는 것으로 절반을 막는다).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const COOKIE_NAME = "sid";

// 토큰의 올바른 모양(randomBytes(32).toString("hex")). 조회와 파기가 같은 검사를
// 쓴다 — 모양이 아니면 DB까지 갈 이유가 없다(uuid 검사와 같은 이유).
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

// 세션 조회는 모든 인증 요청과 소켓 연결마다 일어난다. 매번 DB를 왕복하면
// 세션 테이블이 서비스 전체의 병목이 되므로 캐시를 앞에 둔다.
// 로그아웃은 아래 destroySession이 즉시 지우므로 TTL과 무관하게 맞다.
//
// 임베딩 캐시(cache.ts)를 같이 쓰다가 따로 뗐다. 이유가 두 가지다.
//
// 하나, 서로를 굶긴다. node-cache의 maxKeys는 넘쳤을 때 오래된 걸 밀어내는 게
// 아니라 set에서 예외를 던지고, 부르는 쪽은 그걸 삼킨다. 한 통을 같이 쓰면
// 서로 다른 질문이 상한을 채우는 순간부터 새 세션이 캐시에 못 들어가고, 그
// 뒤로는 인증 요청이 전부 DB로 간다 — 질문 폭주가 로그인을 무너뜨리는 길이
// 열리는 셈이다. 라우트를 전부 로그인 뒤로 넣으면서 이 경로가 실제로 생겼다.
//
// 둘, 지표가 섞인다. /api/metrics의 cache.hitRate는 "질문 임베딩 캐시 적중률"로
// 문서에 적혀 있고(RELIABILITY.md의 미스 1197ms 대 히트 0.05ms 측정), 대시보드도
// 그 이름으로 보여준다. 세션 조회는 훨씬 자주 일어나고 거의 항상 적중하므로
// 같은 통계에 넣으면 적중률이 부풀려져, 그 숫자로 임베딩 캐시를 판단할 수 없다.
const sessionCache = new NodeCache({
  stdTTL: 600, // 10분
  maxKeys: 20_000,
  checkperiod: 120,
});

// 파기 표식(tombstone) — "지웠다"는 사실을 잠깐 기억한다.
//
// 없으면 이런 인터리빙이 뚫린다: 요청 R이 DB에서 (아직 유효한) 세션 행을 읽음
// → 로그아웃이 캐시와 DB에서 세션을 지움 → R이 읽어둔 결과를 캐시에 되넣음.
// 그 순간부터 파기된 토큰이 캐시 TTL(10분) 동안 모든 인증을 통과한다 — 다른
// 탭의 요청 하나가 로그아웃과 겹치는 것으로 충분하고, 쿠키를 탈취한 쪽은
// 요청을 계속 흘려 이 레이스를 의도적으로 이길 수 있다. "로그아웃은
// destroySession이 즉시 지우므로 맞다"는 위 보증이 정확히 여기서 깨진다.
//
// 표식의 수명은 "파기 시점에 진행 중이던 조회가 끝날 때까지"면 충분하지만
// (밀리초 단위), 여유 있게 캐시 TTL과 맞춘다. 상한을 넘치면(10분에 로그아웃
// 2만 건 — 사실상 공격) 표식을 못 남기는 대신 캐시를 통째로 비운다 —
// 정확성이 캐시 적중률보다 먼저다.
const destroyedTokens = new NodeCache({
  stdTTL: 600,
  maxKeys: 20_000,
  checkperiod: 120,
});

// 캐시가 꽉 차도 요청은 살아야 한다 — 없으면 DB를 한 번 더 볼 뿐이다.
function cacheSession(token: string, user: SessionUser): void {
  if (destroyedTokens.has(token)) return; // 파기와 겹친 조회의 되넣기를 막는다
  try {
    sessionCache.set(token, user);
  } catch {
    // maxKeys 초과. 캐시는 있으면 좋고 없어도 되는 것이다(cache.ts와 같은 판단).
  }
}

export async function createSession(user: SessionUser): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writePool.query(
    `insert into sessions (token, user_id, expires_at) values ($1, $2, $3)`,
    [token, user.id, new Date(Date.now() + SESSION_TTL_MS)]
  );
  cacheSession(token, user);
  return token;
}

export async function sessionUser(token: string): Promise<SessionUser | null> {
  if (!TOKEN_SHAPE.test(token)) return null; // 모양부터

  const cached = sessionCache.get<SessionUser>(token);
  if (cached) return cached;

  // 읽기 풀을 쓴다. 쓰기 풀(max 5)은 문서 업로드가 청크 300개를 한 트랜잭션
  // 안에서 넣는 동안 커넥션을 붙잡는 곳인데, 라우트를 전부 로그인 뒤로 넣은
  // 뒤로는 세션 조회가 모든 인증 요청에 붙는다. 그대로 두면 업로드 한 번이
  // 전원의 세션 조회를 막아 API 전체가 멎는다 — Bulkhead를 세워둔 이유가
  // 정확히 그것인데, 정작 제일 뜨거운 읽기를 쓰기 쪽에 얹고 있던 셈이다.
  //
  // 두 풀은 같은 DATABASE_URL을 보므로(db.ts) 방금 만든 세션을 못 읽는
  // 복제 지연 문제는 없다. 게다가 createSession이 곧바로 캐시에 넣어서,
  // 발급 직후의 조회는 애초에 DB까지 오지 않는다.
  const { rows } = await readPool.query<UserRow>(
    `select u.id, u.username, u.display_name, u.is_guest
       from sessions s join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;

  const user = toUser(row);
  cacheSession(token, user);
  return user;
}

// 세션이 파기될 때 알아야 하는 곳이 등록하는 훅. 실시간 게이트웨이가 쓴다 —
// 로그아웃은 HTTP에서 일어나지만 끊어야 할 연결은 소켓에 있고, 이 파일이
// socket.io를 알면 계층이 거꾸로 선다(auth는 저수준, gateway가 auth를 쓴다).
type SessionDestroyedListener = (token: string) => void;
const sessionDestroyedListeners: SessionDestroyedListener[] = [];
export function onSessionDestroyed(listener: SessionDestroyedListener): void {
  sessionDestroyedListeners.push(listener);
}

export async function destroySession(token: string): Promise<void> {
  // 모양이 아니면 우리가 발급한 토큰일 수 없다. 여기서 안 거르면 로그아웃
  // 요청에 실린 아무 문자열이나 writePool(max 5)의 DELETE가 된다 — 로그인도
  // 안 된 요청이 업로드·로그인과 같은 풀을 쓰게 두는 셈이다.
  if (!TOKEN_SHAPE.test(token)) return;

  // 표식 먼저, 삭제는 다음. 순서가 반대면 "캐시에서 지웠는데 진행 중이던
  // 조회가 되넣는" 틈이 표식 전에 생긴다(위 destroyedTokens 주석).
  try {
    destroyedTokens.set(token, true);
  } catch {
    sessionCache.flushAll(); // 표식을 못 남기면 통째로 비운다 — 정확성 우선
  }
  sessionCache.del(token);

  // DB 삭제 전에 알린다 — DB가 순간 흔들려도 이 세션의 소켓은 끊어야
  // "로그아웃했는데 채팅은 계속 된다"가 안 된다. 실패하면 만료 정리가 걷어간다.
  for (const listener of sessionDestroyedListeners) listener(token);

  await writePool.query(`delete from sessions where token = $1`, [token]);
}

// 만료 세션 청소. 지우는 사람이 없으면 로그인할 때마다 한 줄씩 영원히 쌓인다
// (chat_images의 보관 기간 정리와 같은 이유·같은 방식).
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const cleaner = setInterval(() => {
  writePool.query(`delete from sessions where expires_at <= now()`).catch((e: unknown) => {
    console.error("세션 정리 실패:", e instanceof Error ? e.message : e);
  });
}, CLEANUP_INTERVAL_MS);
cleaner.unref();

// --- 쿠키 ---

// cookie-parser를 안 쓰고 직접 읽는다. 쿠키가 하나(sid)뿐이라 "이름=값을
// 세미콜론으로 나눈다"가 전부다.
export function tokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

// 프록시(Render) 뒤에서는 우리에게 닿는 연결이 http라 req.secure가 늘 false다.
// 프록시가 붙여주는 원래 프로토콜을 본다 (clientip.ts가 IP에 대해 하는 것과 동일).
function isHttps(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return req.secure || proto?.split(",")[0]?.trim() === "https";
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    // JS에서 못 읽게. 토큰을 다루는 코드가 클라이언트에 아예 없는 이유다.
    "HttpOnly",
    // 다른 사이트에서 시작된 요청에는 안 실린다(CSRF의 절반을 여기서 막는다).
    // Strict가 아닌 이유: 링크로 들어온 첫 화면도 로그인 상태여야 해서다.
    "SameSite=Lax",
  ];
  // https에서만 Secure를 붙인다. 로컬(http)에서 Secure를 붙이면 브라우저가
  // 쿠키를 버려서 개발 환경에서만 로그인이 안 되는 미스터리가 된다.
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

// 요청에서 로그인한 사용자를 꺼낸다. 미들웨어로 req에 심는 대신 필요한 곳이
// 직접 부른다 — Express의 Request 타입을 전역으로 늘리는 마법 없이, 인증이
// 필요한 자리가 코드에 그대로 보이게.
export async function userFromRequest(req: Request): Promise<SessionUser | null> {
  const token = tokenFromCookieHeader(req.headers.cookie);
  return token ? sessionUser(token) : null;
}

// 로그인한 사람만 통과시키는 문.
//
// 위의 userFromRequest는 "누구인지"를 묻는 함수고, 이건 "들여보낼지"만 정한다.
// 사용자 객체를 req에 심지 않는 이유는 이 파일 위쪽에 적어둔 것과 같다 —
// Express의 Request 타입을 전역으로 늘리는 마법 없이, 사용자가 필요한 자리는
// userFromRequest를 직접 부르게 둔다. 지금 이 문 뒤의 라우트들은 사용자가
// 누구인지 알 필요가 없다(문서 코퍼스가 공용이라 열람 범위가 갈리지 않는다).
//
// 그래서 이건 인증(authentication)까지다. 인가(authorization) — "이 사람이
// 볼 수 있는 문서만" — 는 아직 못 한다. documents에 소유 그룹 컬럼이 없어서
// 저장소 어댑터가 범위 검색을 아예 막아뒀다(adapters/store.ts). 그 컬럼이
// 생기는 날 이 문 뒤에서 Scope가 사용자 것으로 채워진다(rag/types.ts).
//
// 실패를 401로 내려보내는 게 중요하다. 프런트는 이 코드를 보고 "요청이 실패했다"가
// 아니라 "더 이상 로그인 상태가 아니다"로 읽고 로그인 화면으로 돌아간다(web/api.ts).
export const requireLogin: RequestHandler = (req, res, next) => {
  void userFromRequest(req)
    .then((user) => {
      if (user) {
        next();
        return;
      }
      res.status(401).json({ error: "로그인이 필요해요." });
    })
    // DB가 죽어서 세션을 못 읽은 것을 "로그인 안 됨"으로 처리하면 안 된다.
    // 그러면 DB 장애가 전원 강제 로그아웃으로 보이고, 프런트는 멀쩡한 세션을
    // 버린 채 로그인 화면을 띄운다. 원인이 다르면 코드도 달라야 한다 — 500으로
    // 올려보내 에러 핸들러가 서버 문제로 기록하게 둔다(index.ts).
    .catch((e: unknown) => next(e));
};
