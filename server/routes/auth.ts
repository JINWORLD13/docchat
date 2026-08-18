// 가입·로그인·게스트 입장 — 계정(auth.ts)을 HTTP에 연결하는 층.
//
// 게스트 입장이 정식 가입과 나란히 있는 이유: 포트폴리오 데모는 회원가입을
// 요구하는 순간 대부분이 돌아선다. 그래서 닉네임 하나로 바로 들어오게 하되,
// 게스트도 users 행으로 만든다 — 메시지·DM·읽음의 모든 로직이 "계정이 아닐
// 수도 있는" 분기 없이 한 모양으로 돌게(schema.sql의 is_guest 주석).

import { Router } from "express";
import {
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  DUMMY_PASSWORD_HASH,
  findUserByUsername,
  hashPassword,
  setSessionCookie,
  tokenFromCookieHeader,
  userFromRequest,
  verifyPassword,
  type SessionUser,
} from "../auth.ts";
import { TokenBuckets } from "../tokenbucket.ts";
import { clientIp } from "../clientip.ts";
import { randomBytes } from "node:crypto";

const router = Router();

// 로그인·가입 전용 제한. 질문용(ratelimit.ts)과 따로 두는 이유는 성격이
// 달라서다 — 이건 도배가 아니라 비밀번호 추측(brute force)을 막는 자리라
// 훨씬 좁게 잡는다. 순간 10번, 이후 6초에 한 번.
const buckets = new TokenBuckets(
  Number(process.env.AUTH_RL_CAPACITY || 10),
  Number(process.env.AUTH_RL_REFILL || 0.17)
);
const IDLE_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => buckets.sweep(IDLE_MS), 60 * 1000);
sweeper.unref();

// 프록시(Render) 뒤에서는 req.ip가 프록시 주소라, 그대로 쓰면 이 제한이
// "전체 공용"이 되어 한 명의 추측 시도가 모두의 로그인을 막는다(clientip.ts).
function limited(req: Parameters<typeof userFromRequest>[0]): boolean {
  const ip = clientIp(req.socket.remoteAddress ?? "", req.headers["x-forwarded-for"]);
  return !buckets.take(ip).ok;
}

// 아이디는 소문자·숫자·밑줄만. 대문자를 섞게 두면 Kim과 kim이 다른 계정이
// 되고, 본인도 어느 쪽으로 가입했는지 모르게 된다 — 받아서 소문자로 눌러
// 저장한다(schema.sql 주석).
const USERNAME = /^[a-z0-9_]{3,20}$/;
const MAX_NAME = 20;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

function readBody(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Postgres unique 위반. 코드 문자열은 pg 문서의 SQLSTATE.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

router.post("/signup", async (req, res) => {
  if (limited(req)) {
    res.status(429).json({ error: "시도가 너무 잦아요. 잠시 후 다시 해주세요." });
    return;
  }
  const body = readBody(req.body);
  const username = str(body.username).trim().toLowerCase();
  const password = str(body.password);
  const displayName = str(body.displayName).trim().slice(0, MAX_NAME) || username;

  if (!USERNAME.test(username)) {
    res.status(400).json({ error: "아이디는 영문 소문자·숫자·밑줄 3~20자예요." });
    return;
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    res.status(400).json({ error: `비밀번호는 ${MIN_PASSWORD}자 이상이어야 해요.` });
    return;
  }

  try {
    const user = await createUser(username, hashPassword(password), displayName, false);
    await startSession(req, res, user);
  } catch (e) {
    if (isUniqueViolation(e)) {
      res.status(409).json({ error: "이미 있는 아이디예요." });
      return;
    }
    console.error("signup error:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "가입 중 오류가 발생했어요. 잠시 후 다시 시도해주세요." });
  }
});

router.post("/login", async (req, res) => {
  if (limited(req)) {
    res.status(429).json({ error: "시도가 너무 잦아요. 잠시 후 다시 해주세요." });
    return;
  }
  const body = readBody(req.body);
  const username = str(body.username).trim().toLowerCase();
  const password = str(body.password);

  const found = await findUserByUsername(username);
  // 없는 아이디에도 해시 검증과 같은 일을 해서 응답 시간을 맞춘다.
  // 안 그러면 "아이디 존재 여부"가 응답 속도로 새서, 로그인 화면이
  // 아이디 수집기로 쓰인다. 오류 문구를 하나로 합친 것도 같은 이유다.
  //
  // 더미 값을 직접 적지 않고 auth.ts에서 가져오는 이유: 여기에 "0f:00" 같은
  // 아무 문자열을 적으면 검증이 진짜 해시와 다른 길로 간다. 실제로 그랬다 —
  // 짧은 값이라 상수 시간 비교가 길이 불일치로 예외를 던졌고, 없는 아이디의
  // 401이 500이 됐다. 시간을 맞추려고 넣은 코드가 상태 코드로 존재 여부를
  // 알려주는, 원래 막으려던 것보다 더 굵은 신호가 된 셈이다.
  const ok = found
    ? verifyPassword(password, found.passwordHash)
    : (verifyPassword(password, DUMMY_PASSWORD_HASH), false);

  if (!found || !ok) {
    res.status(401).json({ error: "아이디 또는 비밀번호가 맞지 않아요." });
    return;
  }
  await startSession(req, res, found);
});

// 게스트 입장: 닉네임 하나로 계정을 만든다. password_hash가 빈 값이라
// 이 계정으로는 영원히 로그인할 수 없다(auth.ts의 verifyPassword) —
// 세션이 끝나면 그 게스트는 끝이다. 데모의 수명과 맞다.
router.post("/guest", async (req, res) => {
  if (limited(req)) {
    res.status(429).json({ error: "시도가 너무 잦아요. 잠시 후 다시 해주세요." });
    return;
  }
  const body = readBody(req.body);
  const displayName = str(body.displayName).trim().slice(0, MAX_NAME);
  if (!displayName) {
    res.status(400).json({ error: "닉네임을 입력해주세요." });
    return;
  }

  try {
    const user = await createUser(`guest_${randomBytes(6).toString("hex")}`, "", displayName, true);
    await startSession(req, res, user);
  } catch (e) {
    console.error("guest error:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "입장 중 오류가 발생했어요. 잠시 후 다시 시도해주세요." });
  }
});

router.post("/logout", async (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (token) await destroySession(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// 화면이 처음 뜰 때 "나 로그인돼 있나"를 묻는 곳.
router.get("/me", async (req, res) => {
  const user = await userFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "로그인이 필요해요." });
    return;
  }
  res.json(me(user));
});

async function startSession(
  req: Parameters<typeof setSessionCookie>[0],
  res: Parameters<typeof setSessionCookie>[1],
  user: SessionUser
): Promise<void> {
  const token = await createSession(user);
  setSessionCookie(req, res, token);
  res.json(me(user));
}

// 응답에 내보내는 모양. password_hash 같은 내부 값이 실수로도 안 나가게
// 여기서 명시적으로 고른다.
function me(user: SessionUser): { id: string; username: string; displayName: string; isGuest: boolean } {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isGuest: user.isGuest,
  };
}

export default router;
