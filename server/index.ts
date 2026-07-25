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
import { attachRealtime } from "./realtime/gateway.ts";
import { roomStats } from "./realtime/rooms.ts";
import { chatRateLimitStats } from "./realtime/ratelimit.ts";
import type { MetricsResponse } from "./types.ts";

const app = express();
// 프록시(배포 시 로드밸런서) 뒤에서 req.ip가 실제 클라이언트 IP를 가리키게 한다.
// true(모든 홉 신뢰)가 아니라 1인 이유: 전부 신뢰하면 클라이언트가
// X-Forwarded-For 헤더를 직접 넣어 req.ip를 조작할 수 있고, IP별로 버킷을
// 나누는 rate limiter가 "요청마다 새 IP"로 통째로 우회된다.
// 신뢰 범위를 우리 인프라(LB 1홉)로 못박아야 그 뒤 값이 스푸핑되지 않는다.
app.set("trust proxy", 1);
app.use(cors());
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

app.use("/api/documents", documentsRouter);
// 이미지는 /api/chat보다 먼저 붙인다. 뒤에 두면 질문용 rate limiter를 먼저
// 통과해야 해서, 사진 몇 장 올린 것 때문에 정작 질문이 막히게 된다.
// 업로드에는 성격에 맞는 별도 제한이 라우터 안에 따로 있다.
app.use("/api/chat/image", imagesRouter);
// rateLimit을 chat 앞단에 둔다: 맨 먼저 사용자별 폭주를 걸러낸 뒤 라우터로 넘긴다.
app.use("/api/chat", rateLimit, chatRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "파일은 1MB 이하만 업로드할 수 있습니다." });
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
