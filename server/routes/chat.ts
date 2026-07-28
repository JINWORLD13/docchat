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
// 샘플 문서 기준 관련 질문은 0.662~0.744, 무관 질문은 0.527~0.587로 갈려 그 사이인 0.62.
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

  // 클라이언트가 떠났는지.
  //
  // 이게 없으면 사용자가 탭을 닫아도 서버는 LLM 스트림을 끝까지 받아 읽고,
  // 이미 죽은 소켓에 계속 write한다. 그동안 admission 슬롯(MAX_INFLIGHT=8) 하나가
  // 잡혀 있으므로, 성질 급한 사용자가 몇 번 새로고침하면 아무도 안 보는 응답들이
  // 처리 슬롯을 다 차지한다 — admission.ts가 피하려던 바로 그 상황이다.
  //
  // 등록 위치가 중요하다. 예전엔 이 리스너를 acquire() 뒤에 붙였는데, 그러면
  // 큐에서 기다리는 동안(최대 2초) 끊긴 연결을 영영 못 알아챈다 — Node는 이미
  // 발생한 이벤트를 늦게 붙인 리스너에게 다시 주지 않기 때문이다. 과부하 때
  // 새로고침을 연타하면 죽은 요청들이 큐 자리를 데드라인까지 차지하고, 승격된
  // 뒤에는 아무도 안 보는 응답을 생성하느라 슬롯까지 잡았다.
  // 감시는 "기다리기 전"부터 시작해야 한다.
  //
  // upstream은 상류(Gemini)에 "그만"이라고 말하는 수단이다. 우리가 for await를
  // 빠져나오는 것만으로는 이미 열린 HTTP 응답이 닫히지 않아, 사용자가 떠난 뒤에도
  // 생성이 끝까지 돌고 토큰이 과금된다. SDK가 abortSignal을 받으므로 연결해준다.
  let aborted = false;
  const upstream = new AbortController();
  res.on("close", () => {
    aborted = true;
    upstream.abort();
  });

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

  // 기다리는 사이에 떠났으면 여기서 끝낸다. 자리를 얻자마자 반납하는 셈이라
  // 뒤에 선 살아 있는 요청에게 그만큼 빨리 넘어간다.
  if (aborted) {
    release();
    res.end();
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
    if (aborted || res.writableEnded) return;
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
    // [회로차단 - 임베딩] 질문을 벡터로 바꾸는 것도 외부 API 호출이다.
    // 여기가 죽으면 검색을 시작할 수조차 없어서 출처도 못 돌려준다 — 생성 실패와
    // 달리 degrade할 거리가 없다. 그래서 할 수 있는 최선은 "빨리 실패하기"다.
    // 회로가 열려 있으면 재시도(0.5+1+2초)로 슬롯을 붙잡고 있지 않고 즉시 알린다.
    if (breaker.embed.isOpen()) {
      send({
        type: "error",
        message: "지금은 질문을 처리할 수 없어요. 잠시 후 다시 시도해주세요.",
      });
      res.end();
      return;
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await embedQuery(question);
      breaker.embed.onSuccess();
    } catch (embedErr) {
      // 예전엔 이 실패가 바깥 catch로 떨어져 "우리 쪽 문제"로 분류됐다.
      // 회로에 기록되지 않으니 임베딩 API가 죽어도 회로는 영영 안 열렸다.
      breaker.embed.onFailure();
      throw embedErr;
    }

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
      const stream = await streamAnswer(question, rows, upstream.signal);
      for await (const chunk of stream) {
        // 떠난 사용자를 위해 토큰을 더 만들지 않는다. 빠져나오면 슬롯은
        // finally에서 곧바로 반납되고, 상류 생성은 abort 신호로 끊는다
        // (break만으로는 Gemini 쪽이 끝까지 돌아 토큰이 계속 과금된다).
        if (aborted) break;
        if (chunk.text) {
          answer += chunk.text;
          send({ type: "delta", text: chunk.text });
        }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? null;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? null;
        }
      }
      // 중간에 끊긴 스트림은 성공이 아니다.
      //
      // 예전엔 여기서 무조건 onSuccess()를 불렀다. 그러면 사용자가 탭을 닫은
      // 것만으로 회로의 실패 카운터가 리셋되고, 반열림 구간에서는 시험 요청을
      // 소비하면서 "복구됐다"고 판정해 회로를 닫아버린다 — 실제로는 아무것도
      // 확인하지 않았는데. 관측 데이터도 마찬가지라, 아래 로그에도 끊긴
      // 답변임을 남긴다. 이 프로젝트가 자기를 판단하는 근거가 이 두 곳이다.
      if (aborted) {
        res.end();
        logQuery({
          question,
          answer: answer ? `${answer} (중단됨)` : "(중단됨)",
          refused: false,
          topSimilarity,
          promptTokens,
          outputTokens,
          latencyMs: Date.now() - started,
        });
        return;
      }
      breaker.onSuccess(); // 성공 → 회로 카운터 리셋
    } catch (llmErr) {
      // 사용자가 떠나서 우리가 끊은 것은 LLM 장애가 아니다. 이걸 실패로 세면
      // 새로고침 몇 번에 회로가 열려 멀쩡한 API를 차단하게 된다.
      if (aborted) {
        res.end();
        return;
      }
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
    // 여기 오는 건 검색·DB 같은 우리 쪽 문제이거나, 임베딩 API 실패다.
    // (생성 실패는 위에서 degrade로 처리되고 여기까지 오지 않는다.)
    // 임베딩 실패도 여기로 오지만 회로에는 이미 기록돼 있다 — 예전엔 그 기록이
    // 없어서 "우리 쪽 문제"라고 적어둔 이 주석이 사실이 아니었다.
    if (!aborted) {
      console.error("chat error:", e);
      send({
        type: "error",
        message: "요청 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.",
      });
    }
    res.end();
  } finally {
    release(); // 성공·실패·거절 무엇이든 자리는 반드시 반납
  }
});

export default router;
