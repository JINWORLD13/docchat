import "dotenv/config";
import express from "express";
import cors from "cors";
import documentsRouter from "./routes/documents.js";
import chatRouter from "./routes/chat.js";
import { readPool, writePool } from "./db.js";
import { cacheStats } from "./cache.js";
import { rateLimit, rateLimitStats } from "./ratelimit.js";
import { admissionStats } from "./admission.js";
import { breakerState, reset as resetBreaker } from "./breaker.js";
import { faults } from "./faults.js";
import { requireAdmin, adminMode } from "./admin.js";

const app = express();
// 프록시(배포 시 로드밸런서) 뒤에서 req.ip가 실제 클라이언트 IP를 가리키게 한다.
// true(모든 홉 신뢰)가 아니라 1인 이유: 전부 신뢰하면 클라이언트가
// X-Forwarded-For 헤더를 직접 넣어 req.ip를 조작할 수 있고, IP별로 버킷을
// 나누는 rate limiter가 "요청마다 새 IP"로 통째로 우회된다.
// 신뢰 범위를 우리 인프라(LB 1홉)로 못박아야 그 뒤 값이 스푸핑되지 않는다.
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// 방어 레이어들의 상태를 한눈에 노출한다.
// 모니터링이 곧 결정력 — 장애 상황에서 어느 레이어가 발동했는지 몇 초 안에
// 파악하려면 이 값들이 보여야 한다. (프로덕션은 Prometheus + Grafana)
app.get("/api/metrics", (req, res) => {
  const s = cacheStats();
  const total = s.hits + s.misses;
  res.json({
    cache: {
      hits: s.hits,
      misses: s.misses,
      hitRate: total ? Math.round((s.hits / total) * 100) / 100 : 0,
      keys: s.keys,
    },
    // Bulkhead: 읽기(질문)와 쓰기(업로드·로그) 풀을 따로 노출. 한쪽이 포화돼도
    // 다른 쪽은 멀쩡한 걸 대시보드에서 눈으로 확인할 수 있다.
    readPool: { total: readPool.totalCount, idle: readPool.idleCount, waiting: readPool.waitingCount },
    writePool: { total: writePool.totalCount, idle: writePool.idleCount, waiting: writePool.waitingCount },
    rateLimit: rateLimitStats(), // 사용자별 제한: 거절 수, 활성 버킷 수
    admission: admissionStats(), // 과부하 제어: 처리 중/대기 수
    breaker: breakerState(), // 회로차단: 열림 여부, 연속 실패 수
    faults, // 현재 주입된 장애 상태 (llmFail)
  });
});

// --- 데모용 관리자 엔드포인트 ---
// 대시보드 버튼이 부른다. 상황을 주입하고, 방어 레이어가 반응하는 걸 실시간으로 본다.
// 고의로 장애를 일으키는 스위치라 반드시 requireAdmin으로 보호한다(admin.js 참고).
app.post("/api/admin/fault", requireAdmin, (req, res) => {
  if (typeof req.body?.llmFail === "boolean") faults.llmFail = req.body.llmFail;
  res.json({ ok: true, faults });
});
app.post("/api/admin/reset", requireAdmin, (req, res) => {
  faults.llmFail = false;
  resetBreaker();
  res.json({ ok: true });
});

app.use("/api/documents", documentsRouter);
// rateLimit을 chat 앞단에 둔다: 맨 먼저 사용자별 폭주를 걸러낸 뒤 라우터로 넘긴다.
app.use("/api/chat", rateLimit, chatRouter);

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "파일은 1MB 이하만 업로드할 수 있습니다." });
  }
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`server: http://localhost:${port}`);
  console.log(`admin 엔드포인트 보호: ${adminMode()}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
  }
});
