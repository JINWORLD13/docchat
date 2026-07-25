import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { createServer } from "node:http";
import documentsRouter from "./routes/documents.ts";
import chatRouter from "./routes/chat.ts";
import imagesRouter from "./routes/images.ts";
import { readPool, writePool, mediaPool, poolStats } from "./db.ts";
import { cacheStats } from "./cache.ts";
import { rateLimit, rateLimitStats } from "./ratelimit.ts";
import { admissionStats } from "./admission.ts";
import { breakerState, reset as resetBreaker } from "./breaker.ts";
import { faults } from "./faults.ts";
import { requireAdmin, adminMode } from "./admin.ts";
import { isAllowedOrigin } from "./origins.ts";
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
const TRUST_PROXY = process.env.TRUST_PROXY ?? "0";
app.set("trust proxy", Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));

// 허용 오리진을 명시한다. 예전엔 cors()를 옵션 없이 써서 모든 오리진에
// Access-Control-Allow-Origin: *를 내줬는데, 그러면 사용자가 방문한 아무 사이트나
// 이 서버에 요청을 보내고 응답까지 읽을 수 있다. 로컬 데모에서는 그게 특히
// 위험하다 — admin 엔드포인트가 "loopback이면 통과"로 열려 있고, 개발자 자신의
// 브라우저에서 나가는 요청은 loopback이라 그 검사를 그대로 통과하기 때문이다.
// (즉 아무 웹페이지나 장애 주입을 걸거나 문서를 지울 수 있었다.)
// 목록은 소켓 쪽과 공유한다 — origins.ts 참고.
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// 방어 레이어들의 상태를 한눈에 노출한다.
// 모니터링이 곧 결정력 — 장애 상황에서 어느 레이어가 발동했는지 몇 초 안에
// 파악하려면 이 값들이 보여야 한다. (프로덕션은 Prometheus + Grafana)
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
    breaker: breakerState(), // 회로차단: 열림 여부, 연속 실패 수
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

// 문서 경로도 같은 사용자별 제한을 태운다. 질문과 예산을 공유하게 되는데,
// 그 편이 낫다고 봤다 — 어차피 한 사람이 쓸 수 있는 총량을 정하는 게 목적이고,
// 목록 조회는 매번 chunks 전체를 조인하므로 공짜가 아니다.
// 변경(추가·수정·삭제)은 라우터 안에서 한 겹 더 막는다(requireWriteAccess).
app.use("/api/documents", rateLimit, documentsRouter);
// 이미지는 /api/chat보다 먼저 붙인다. 뒤에 두면 질문용 rate limiter를 먼저
// 통과해야 해서, 사진 몇 장 올린 것 때문에 정작 질문이 막히게 된다.
// 업로드에는 성격에 맞는 별도 제한이 라우터 안에 따로 있다.
app.use("/api/chat/image", imagesRouter);
// rateLimit을 chat 앞단에 둔다: 맨 먼저 사용자별 폭주를 걸러낸 뒤 라우터로 넘긴다.
app.use("/api/chat", rateLimit, chatRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const info = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};

  if (info.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "파일은 1MB 이하만 업로드할 수 있습니다." });
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
