import "dotenv/config";
import path from "node:path";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { createServer } from "node:http";
import documentsRouter from "./routes/documents.ts";
import chatRouter from "./routes/chat.ts";
import imagesRouter from "./routes/images.ts";
import kakaoRouter from "./routes/kakao.ts";
import authRouter from "./routes/auth.ts";
import { readPool, writePool, mediaPool, poolStats } from "./db.ts";
import { cacheStats } from "./cache.ts";
import { rateLimit, rateLimitStats } from "./ratelimit.ts";
import { admissionStats } from "./admission.ts";
import {
  breakerState,
  embed as embedBreaker,
  local as localBreaker,
  reset as resetBreaker,
} from "./breaker.ts";
import { faults } from "./faults.ts";
import { requireAdmin, adminMode } from "./admin.ts";
import { isAllowedOrigin } from "./origins.ts";
import { requireLogin } from "./auth.ts";
import { attachRealtime } from "./realtime/gateway.ts";
import { roomStats } from "./realtime/rooms.ts";
import { chatRateLimitStats } from "./realtime/ratelimit.ts";
import type { MetricsResponse } from "./types.ts";

const app = express();

// req.ip를 무엇으로 정할지. rate limiter가 IP별로 버킷을 나누므로,
// 이 값이 조작 가능하면 제한 전체가 무의미해진다.
//
// 기본값은 "신뢰하지 않음"이다. 그러면 req.ip는 실제 TCP 연결의 주소가 되어
// 클라이언트가 손댈 수 없다. 예전엔 여기가 무조건 1이었는데, 그건 앞에
// 프록시가 실제로 있을 때만 맞는 설정이다. 프록시 없이 직접 노출된 상태에서
// 1을 주면 Express가 X-Forwarded-For의 마지막 값을 req.ip로 삼기 때문에,
// 헤더 한 줄로 "요청마다 새 IP"가 되어 제한이 통째로 뚫린다.
// (실제로 그랬다 — XFF를 바꿔가며 30번 쏘면 30번 다 통과했다.)
//
// 그러므로 신뢰는 배포 형태를 아는 사람이 켜야 한다. 로드밸런서 뒤에 둘 때만
// TRUST_PROXY에 홉 수를 준다. 홉 수를 정확히 세는 게 중요하다 — 실제보다
// 크게 주면 그만큼 클라이언트가 써넣은 값을 신뢰하게 된다.
//
// 배포에서는 render.yaml이 TRUST_PROXY=1을 준다. 한동안 그걸 빠뜨린 채로
// 배포돼 있었는데, 그러면 접속자 전원의 req.ip가 프록시 IP 하나로 같아진다 —
// "IP별" 제한이 통째로 "전체 공용" 제한이 되어, 한 사람이 질문 몇 개를 던지면
// 다른 방문자가 429를 받았다. 설정이 코드보다 조용히 틀리는 자리다.
const TRUST_PROXY = process.env.TRUST_PROXY ?? "0";
app.set("trust proxy", Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));

// 허용 오리진을 명시한다. 예전엔 cors()를 옵션 없이 써서 모든 오리진에
// Access-Control-Allow-Origin: *를 내줬는데, 그러면 사용자가 방문한 아무 사이트나
// 이 서버에 요청을 보내고 응답까지 읽을 수 있다.
// 목록은 소켓 쪽과 공유한다 — origins.ts 참고.
app.use(cors((req, cb) => cb(null, { origin: isAllowedOrigin(req.headers.origin, req.headers.host) })));

// CORS만으로는 "요청이 실행되는 것"을 못 막는다.
//
// cors 미들웨어는 오리진이 허용 목록에 없으면 응답 헤더를 빼고 next()를 부른다.
// 즉 브라우저가 응답을 못 읽을 뿐, 서버는 요청을 이미 처리한 뒤다. preflight가
// 붙는 요청(JSON 본문·DELETE)은 브라우저가 먼저 막아주지만, 그렇지 않은 것들이
// 있다 — 본문 없는 POST와 multipart 업로드는 "단순 요청"이라 preflight가 없다.
// 그래서 로컬에서 서버를 켜둔 채 아무 웹사이트나 방문하면, 그 페이지가
// /api/admin/reset을 부르거나 내 문서 목록에 파일을 밀어넣을 수 있었다.
// (admin은 loopback이면 통과인데, 내 브라우저에서 나가는 요청이 곧 loopback이다.)
//
// 그래서 상태를 바꾸는 메서드는 Origin을 직접 확인하고 거절한다. Origin이 아예
// 없는 요청(curl·서버 간 호출)은 브라우저가 만든 것이 아니므로 통과시킨다 —
// 브라우저는 이 헤더를 빼거나 위조할 수 없다는 점이 이 검사의 근거다.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method) || isAllowedOrigin(req.headers.origin, req.headers.host)) {
    next();
    return;
  }
  res.status(403).json({ error: "허용되지 않은 요청입니다." });
});

// 본문 크기 상한을 업로드 한도와 맞춘다.
//
// express.json()의 기본값은 100KB인데 문서 업로드는 1MB까지 받는다. 그 사이
// 크기의 문서는 업로드도 되고 열람도 되는데 저장(PUT)만 413으로 실패했다.
// 심지어 사용자에게는 "요청이 올바르지 않습니다"라는 무관한 문구가 떴다.
// 한 리소스에 상한이 두 개 있으면 반드시 서로 맞춰야 한다.
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// 방어 레이어들의 상태를 한눈에 노출한다.
// 모니터링이 곧 결정력 — 장애 상황에서 어느 레이어가 발동했는지 몇 초 안에
// 파악하려면 이 값들이 보여야 한다. (프로덕션은 Prometheus + Grafana)
//
// 로그인을 요구하지 않는 유일한 API다. 일부러 그렇게 뒀다.
// 여기 담기는 건 전부 집계 수치(적중률·풀 대기·거절 수·회로 상태)라 사용자
// 데이터도 문서 내용도 들어가지 않고, 반대로 이 값을 읽는 쪽에는 브라우저가
// 아닌 것들이 있다 — 부하 측정(scripts/load-chat.ts)과 시연(demo-defense.ts),
// 그리고 배포 환경의 상태 확인이다. 관측 지점을 로그인 뒤로 넣으면 정작
// "로그인이 안 된다"는 장애를 이 화면으로 진단할 수 없게 된다.
app.get("/api/metrics", (_req, res) => {
  const s = cacheStats();
  const total = s.hits + s.misses;

  // 반환 타입을 명시해두면, 여기 필드를 바꿨을 때 이 응답을 읽는 대시보드와
  // 측정 스크립트가 함께 깨져서 바로 드러난다 (types.ts의 MetricsResponse 참고).
  const body: MetricsResponse = {
    cache: {
      hits: s.hits,
      misses: s.misses,
      hitRate: total ? Math.round((s.hits / total) * 100) / 100 : 0,
      keys: s.keys,
    },
    // Bulkhead: 읽기(질문)와 쓰기(업로드·로그) 풀을 따로 노출. 한쪽이 포화돼도
    // 다른 쪽은 멀쩡한 걸 대시보드에서 눈으로 확인할 수 있다.
    readPool: poolStats(readPool),
    writePool: poolStats(writePool),
    // 채팅 이미지 전용. 사진 많은 방이 질문 응답을 굶기지 않는지 여기서 본다.
    mediaPool: poolStats(mediaPool),
    rateLimit: rateLimitStats(), // 사용자별 제한: 거절 수, 활성 버킷 수
    admission: admissionStats(), // 과부하 제어: 처리 중/대기 수
    breaker: breakerState(), // 회로차단(생성): 열림 여부, 연속 실패 수
    embedBreaker: embedBreaker.state(), // 회로차단(임베딩)
    // 회로차단(로컬 생성). 열려 있다는 건 온디바이스가 죽어 모든 질문이
    // 보루(Gemini)로 가고 있다는 뜻이다 — 지표 없이는 알아챌 수 없는 상태.
    localBreaker: localBreaker.state(),
    // 실시간 채팅: 방/접속자 수, 도배로 막힌 메시지 수
    realtime: { ...roomStats(), messagesRejected: chatRateLimitStats().rejected },
    faults, // 현재 주입된 장애 상태 (llmFail)
  };
  res.json(body);
});

// --- 데모용 관리자 엔드포인트 ---
// 대시보드 버튼이 부른다. 상황을 주입하고, 방어 레이어가 반응하는 걸 실시간으로 본다.
// 고의로 장애를 일으키는 스위치라 반드시 requireAdmin으로 보호한다(admin.ts 참고).
app.post("/api/admin/fault", requireAdmin, (req, res) => {
  if (typeof req.body?.llmFail === "boolean") faults.llmFail = req.body.llmFail;
  res.json({ ok: true, faults });
});
app.post("/api/admin/reset", requireAdmin, (_req, res) => {
  faults.llmFail = false;
  resetBreaker();
  res.json({ ok: true });
});

// 제한 → 로그인 → 라우터 순서다. 순서에 이유가 있다.
//
// requireLogin은 세션을 확인하느라 DB를 볼 수 있다(캐시에 없는 토큰일 때 —
// auth.ts). 그걸 rateLimit 앞에 두면, 아무 값이나 64자리 hex로 지어낸 쿠키를
// 달고 쏘는 것만으로 요청당 세션 조회 한 번씩을 강제할 수 있다. 로그인도 안 된
// 요청이 DB 왕복을 만드는 셈이라, 문을 달았더니 그 문이 증폭기가 되는 꼴이다.
// 메모리에서 끝나는 검사(rateLimit)를 먼저 통과시킨 뒤에 DB를 본다.
// (routes/chat.ts가 "잘못된 요청이 처리 슬롯을 잡아먹지 않게" 검증을 admission
//  앞에 두는 것과 같은 기준 — 싼 검사가 비싼 검사보다 앞이다.)

// 문서 경로도 같은 사용자별 제한을 태운다. 질문과 예산을 공유하게 되는데,
// 그 편이 낫다고 봤다 — 어차피 한 사람이 쓸 수 있는 총량을 정하는 게 목적이고,
// 목록 조회는 매번 chunks 전체를 조인하므로 공짜가 아니다.
// 변경(추가·수정·삭제)은 라우터 안에서 한 겹 더 막는다(requireWriteAccess) —
// 로그인은 "누구든 들어온 사람"이고 그쪽은 "코퍼스를 바꿔도 되는 사람"이라,
// 두 문은 겹치는 게 아니라 서로 다른 것을 막는다.
app.use("/api/documents", rateLimit, requireLogin, documentsRouter);
// 이미지는 /api/chat보다 먼저 붙인다. 뒤에 두면 질문용 rate limiter를 먼저
// 통과해야 해서, 사진 몇 장 올린 것 때문에 정작 질문이 막히게 된다.
// 업로드에는 성격에 맞는 별도 제한이 라우터 안에 따로 있다.
// 로그인 검사도 그 제한 뒤에 있다(routes/images.ts) — 위와 같은 순서 이유다.
app.use("/api/chat/image", imagesRouter);
// rateLimit을 chat 앞단에 둔다: 맨 먼저 사용자별 폭주를 걸러낸 뒤 라우터로 넘긴다.
app.use("/api/chat", rateLimit, requireLogin, chatRouter);

// 카카오톡 스킬 웹훅. IP 기반 rateLimit을 일부러 안 태운다 — 요청이 전부
// 카카오 서버 IP로 오므로 IP당 제한이 "전체 사용자 공용" 제한이 되고, 사용자
// 몇 명이 동시에 물어보면 서로를 막는다. 대신 라우터 안에서 카카오 사용자
// id로 같은 성격의 제한을 건다.
app.use("/api/kakao", kakaoRouter);

// 계정. 질문용 rateLimit 대신 라우터 안의 전용 제한(비밀번호 추측 방어)을 쓴다.
app.use("/api/auth", authRouter);

// 프런트 빌드 결과물(web/dist)을 같은 오리진에서 서빙한다.
// 배포를 Netlify/Render로 나누지 않고 이 서버 하나로 합친 이유: web/api.ts와
// realtime/socket.ts가 상대경로("/api")·오리진 없는 io()로 "같은 오리진"을
// 가정하고 있어서, 나눠 배포하면 CORS·소켓 주소를 프런트 코드에 따로 심어줘야
// 한다. 같은 프로세스가 정적 파일까지 서빙하면 그 문제 자체가 생기지 않는다.
// 로컬 개발(`web`에서 `npm run dev`, 포트 5173)에는 영향 없다 — web/dist가
// 없으면 express.static은 그냥 next()로 넘기고 아래 404로 떨어진다.
app.use(express.static(path.join(import.meta.dirname, "../web/dist")));

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const info = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};

  if (info.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "파일은 1MB 이하만 업로드할 수 있습니다." });
    return;
  }

  // multer 오류는 전부 클라이언트 잘못이다(필드 이름이 다르다, 파일이 너무 많다,
  // 필드 값이 길다…). 그런데 MulterError에는 status가 없어서 아래 분류가 전부
  // 500으로 떨어뜨리고 있었다 — 바로 아래 주석이 "클라이언트 잘못이 서버 에러율에
  // 섞이면 지표로 판단할 수 없다"고 적어둔 그 일이 여기서 벌어지고 있었다.
  // 대시보드가 보여주는 그 에러율이 이 프로젝트의 논거라 더 아픈 자리다.
  if (typeof info.code === "string" && info.code.startsWith("LIMIT_")) {
    res.status(400).json({ error: "업로드 요청이 올바르지 않습니다." });
    return;
  }

  // 응답이 이미 나가기 시작했으면 여기서 상태 코드를 다시 쓸 수 없다.
  // (SSE처럼 헤더를 먼저 보내는 경로가 그렇다.) 억지로 쓰면
  // ERR_HTTP_HEADERS_SENT가 나므로, 연결을 정리해주는 Express 기본 핸들러에 넘긴다.
  if (res.headersSent) {
    next(err);
    return;
  }

  // 4xx와 5xx를 구분한다. express.json()은 깨진 본문에 status 400을,
  // 본문 크기 초과에는 413을 담아 던지는데, 예전엔 그걸 무시하고 전부 500으로
  // 내렸다. 신뢰성이 주제인 서버에서 이건 단순한 표기 문제가 아니다 —
  // 클라이언트 잘못이 서버 에러율에 섞이면, 그 지표를 보고 판단할 수 없게 된다.
  const status = typeof info.status === "number" ? info.status : typeof info.statusCode === "number" ? info.statusCode : 500;

  if (status === 413) {
    // 크기 초과는 원인을 알려줘야 고칠 수 있다. "올바르지 않습니다"로 뭉개면
    // 사용자는 무엇을 줄여야 하는지 알 수 없다.
    res.status(413).json({ error: "내용이 너무 큽니다. 크기를 줄여 다시 시도해주세요." });
    return;
  }

  if (status >= 400 && status < 500) {
    res.status(status).json({ error: "요청이 올바르지 않습니다." });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
};
app.use(errorHandler);

// Express가 직접 listen하지 않고 http 서버를 우리가 만든다.
// Socket.IO가 붙을 곳이 이 http 서버이기 때문 — 같은 포트에서 HTTP(문서 Q&A)와
// WebSocket(실시간 채팅)을 함께 받는다.
const httpServer = createServer(app);
attachRealtime(httpServer);

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => {
  console.log(`server: http://localhost:${port}`);
  console.log(`  - 문서 Q&A: /api/* (SSE 스트리밍)`);
  console.log(`  - 실시간 채팅: /socket.io (WebSocket)`);
  console.log(`admin 엔드포인트 보호: ${adminMode()}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
  }
});
