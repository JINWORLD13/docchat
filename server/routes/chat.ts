import { Router } from "express";
import { readPool, writePool } from "../db.ts";
import { embedQuery, streamAnswer } from "../gemini.ts";
import { acquire, release } from "../admission.ts";
import * as breaker from "../breaker.ts";
import type { ChatEvent, RetrievedChunk } from "../types.ts";

const router = Router();

const TOP_K = 5;
const MAX_QUESTION_LENGTH = 500;
// 이 값보다 유사도가 낮으면 문서에 없는 질문으로 보고 답변을 거절한다.
// 샘플 문서 기준 관련 질문은 0.66~0.74, 무관 질문은 0.52~0.59로 갈려 그 사이인 0.62.
const THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD || 0.62);

interface QueryLog {
  question: string;
  answer?: string | null;
  refused: boolean;
  topSimilarity: number;
  promptTokens?: number | null;
  outputTokens?: number | null;
  latencyMs: number;
}

// 질문 로그(관측용)를 사용자 응답 경로에서 빼서 백그라운드로 쓴다.
// 로그를 기다리느라 사용자 응답이 늦을 이유가 없고, 부하 때 요청당 DB 왕복을 하나 줄인다.
function logQuery(row: QueryLog): void {
  const {
    question,
    answer = null,
    refused,
    topSimilarity,
    promptTokens = null,
    outputTokens = null,
    latencyMs,
  } = row;
  // 로그는 쓰기 풀로. 로그가 몰려도 질문 검색(읽기 풀)은 영향받지 않는다.
  writePool
    .query(
      `insert into query_logs
         (question, answer, refused, top_similarity, prompt_tokens, output_tokens, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [question, answer, refused, topSimilarity, promptTokens, outputTokens, latencyMs]
    )
    .catch((e: unknown) => {
      console.error("query_logs insert 실패:", e instanceof Error ? e.message : e);
    });
}

router.post("/", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    res.status(400).json({ error: "질문을 입력해주세요." });
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: `질문은 ${MAX_QUESTION_LENGTH}자 이하로 입력해주세요.` });
    return;
  }

  // [과부하 제어] 자리를 못 얻으면 무한 대기 대신 즉시 429로 거절한다(load shedding).
  // 검증(빈 질문·길이)은 이 앞에서 처리한다 — 잘못된 요청이 처리 슬롯을 잡아먹지 않게.
  const admitted = await acquire();
  if (!admitted) {
    res.setHeader("Retry-After", "1");
    res
      .status(429)
      .json({ error: "요청이 많아 잠시 처리할 수 없어요. 잠시 후 다시 시도해주세요." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 보낼 수 있는 이벤트를 ChatEvent 유니온으로 못박는다.
  // 프런트(web/src/types.ts)가 같은 유니온을 읽으므로, 여기서 이벤트를 하나
  // 추가하면 프런트에서 처리를 빠뜨렸을 때 타입 검사에 걸린다.
  const send = (data: ChatEvent): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const started = Date.now();

  // [degradation] LLM을 못 쓰는 상황에서도 사용자를 빈손으로 두지 않는다.
  // 출처(sources)는 이미 보냈으니, 답변 생성만 포기하고 그 사실을 알린다.
  const degrade = (): void => {
    send({ type: "delta", text: "지금 답변 생성이 어려워요. 위 출처 문서를 직접 확인해주세요." });
    send({ type: "done", usage: { promptTokens: null, outputTokens: null } });
  };

  try {
    const queryEmbedding = await embedQuery(question);

    // <=>는 pgvector의 코사인 거리 연산자. 거리가 작을수록 비슷하다.
    // 읽기 풀 사용 — 이 경로가 사수 대상(질문 응답)이라 쓰기와 격리한다.
    const { rows } = await readPool.query<RetrievedChunk>(
      `select c.content, d.filename,
              1 - (c.embedding <=> $1::vector) as similarity
         from chunks c
         join documents d on d.id = c.document_id
        order by c.embedding <=> $1::vector
        limit $2`,
      [JSON.stringify(queryEmbedding), TOP_K]
    );

    const topSimilarity = rows[0]?.similarity ?? 0;

    // [부하 감소 + 헛소리 방지] 유사도가 낮으면 LLM을 아예 부르지 않고 거절한다.
    if (rows.length === 0 || topSimilarity < THRESHOLD) {
      send({
        type: "refusal",
        message:
          "업로드된 문서에서 관련 내용을 찾지 못했어요. 질문을 바꿔보시거나 관련 문서를 올려주세요.",
      });
      res.end();
      logQuery({ question, refused: true, topSimilarity, latencyMs: Date.now() - started });
      return;
    }

    // 답변보다 근거를 먼저 보낸다 (스트리밍 중에도 출처가 보이고, degrade 시에도 남는다)
    send({
      type: "sources",
      sources: rows.map((r, i) => ({
        index: i + 1,
        filename: r.filename,
        snippet: r.content.slice(0, 100),
        similarity: Math.round(r.similarity * 100) / 100,
      })),
    });

    // [회로차단] LLM이 최근 연속 장애면 회로가 열려 있다 → 부르지도 않고 바로 대체 응답.
    if (breaker.isOpen()) {
      degrade();
      res.end();
      logQuery({
        question,
        answer: "(degraded: breaker open)",
        refused: false,
        topSimilarity,
        latencyMs: Date.now() - started,
      });
      return;
    }

    let answer = "";
    let promptTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
      const stream = await streamAnswer(question, rows);
      for await (const chunk of stream) {
        if (chunk.text) {
          answer += chunk.text;
          send({ type: "delta", text: chunk.text });
        }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? null;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? null;
        }
      }
      breaker.onSuccess(); // 성공 → 회로 카운터 리셋
    } catch (llmErr) {
      // LLM 생성 실패(재시도까지 소진 후). 회로에 실패를 기록하고 우아하게 degrade.
      breaker.onFailure();
      console.error("LLM 생성 실패:", llmErr instanceof Error ? llmErr.message : llmErr);
      degrade();
      res.end();
      logQuery({
        question,
        answer: "(degraded: llm error)",
        refused: false,
        topSimilarity,
        latencyMs: Date.now() - started,
      });
      return;
    }

    send({ type: "done", usage: { promptTokens, outputTokens } });
    res.end();
    logQuery({
      question,
      answer,
      refused: false,
      topSimilarity,
      promptTokens,
      outputTokens,
      latencyMs: Date.now() - started,
    });
  } catch (e) {
    // 여기 오는 건 검색·DB 등 우리 쪽 문제. LLM 장애는 위에서 degrade로 처리됨.
    console.error("chat error:", e);
    send({ type: "error", message: "요청 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요." });
    res.end();
  } finally {
    release(); // 성공·실패·거절 무엇이든 자리는 반드시 반납
  }
});

export default router;
