// RAG 엔진 — 질문 하나를 이벤트 흐름으로 바꾸는 부분.
//
// 원래 이 로직은 routes/chat.ts 안에 SSE 전송·Gemini 호출·pgvector SQL·과부하
// 제어와 함께 섞여 있었다. 그래서 두 가지 문제가 있었다.
//   1) 다른 곳에 못 쓴다. Teams 봇을 만들려면 통째로 복사해야 했다.
//   2) 테스트를 못 짠다. 서버의 다른 모듈은 전부 .test.ts가 있는데 여기만
//      없었던 건 실력 문제가 아니라, DB와 외부 API 없이는 부를 수가 없어서였다.
//
// 그래서 코어는 res를 만지지 않고 이벤트를 yield하고, 외부 의존성은 전부
// 인자로 받는다. 그 결과 engine.test.ts에서 가짜 포트만 끼우면 전 분기를
// 네트워크 없이 검사할 수 있다.

import {
  DependencyUnavailableError,
  type AnswerGenerator,
  type Embedder,
  type QueryLogger,
  type QueryLogRecord,
  type QuestionImage,
  type RagEvent,
  type Scope,
  type VectorStore,
} from "./types.ts";

export interface RagPolicy {
  topK: number;
  // 이 값보다 유사도가 낮으면 문서에 없는 질문으로 보고 답변을 거절한다.
  threshold: number;
  maxQuestionLength: number;
  // 출처 미리보기로 잘라 보낼 길이.
  snippetLength: number;
}

export interface RagMessages {
  emptyQuestion: string;
  tooLong: (max: number) => string;
  refusal: string;
  embedUnavailable: string;
  degraded: string;
  error: string;
}

export const DEFAULT_POLICY: RagPolicy = {
  topK: 5,
  // 샘플 문서 기준 관련 질문은 0.662~0.744, 무관 질문은 0.527~0.587로 갈려 그 사이인 0.62.
  threshold: 0.62,
  maxQuestionLength: 500,
  snippetLength: 100,
};

export const DEFAULT_MESSAGES: RagMessages = {
  emptyQuestion: "질문을 입력해주세요.",
  tooLong: (max) => `질문은 ${max}자 이하로 입력해주세요.`,
  refusal: "업로드된 문서에서 관련 내용을 찾지 못했어요. 질문을 바꿔보시거나 관련 문서를 올려주세요.",
  embedUnavailable: "지금은 질문을 처리할 수 없어요. 잠시 후 다시 시도해주세요.",
  degraded: "지금 답변 생성이 어려워요. 위 출처 문서를 직접 확인해주세요.",
  error: "요청 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.",
};

export interface RagDeps {
  embedder: Embedder;
  store: VectorStore;
  generator: AnswerGenerator;
  // 관측용. 없으면 아무것도 남기지 않는다(CLI처럼 로그가 필요 없는 앱).
  logger?: QueryLogger | undefined;
  policy?: Partial<RagPolicy> | undefined;
  messages?: Partial<RagMessages> | undefined;
  // 테스트에서 지연 시간을 고정하려고 뚫어둔다. 기본은 Date.now.
  now?: (() => number) | undefined;
}

export type ValidationResult = { ok: true } | { ok: false; message: string };

export interface RagEngine {
  // 질문 검증. 전송 계층이 이 결과를 자기 방식으로 옮긴다
  // (HTTP는 400, Teams는 안내 메시지).
  validate(question: string): ValidationResult;
  ask(
    question: string,
    scope: Scope,
    signal: AbortSignal,
    // 질문에 붙은 이미지(선택). 검색은 여전히 텍스트로만 한다 — 이미지는
    // 임베딩하지 않고 생성기에게만 넘어간다. 자세한 이유는 ask 구현의 [3] 참고.
    image?: QuestionImage
  ): AsyncIterable<RagEvent>;
}

export function createRagEngine(deps: RagDeps): RagEngine {
  const policy: RagPolicy = { ...DEFAULT_POLICY, ...deps.policy };
  const messages: RagMessages = { ...DEFAULT_MESSAGES, ...deps.messages };
  const now = deps.now ?? Date.now;
  const { embedder, store, generator, logger } = deps;

  const log = (record: QueryLogRecord): void => logger?.log(record);

  return {
    validate(question: string): ValidationResult {
      if (!question) return { ok: false, message: messages.emptyQuestion };
      if (question.length > policy.maxQuestionLength) {
        return { ok: false, message: messages.tooLong(policy.maxQuestionLength) };
      }
      return { ok: true };
    },

    async *ask(question, scope, signal, image): AsyncIterable<RagEvent> {
      const started = now();
      const elapsed = (): number => now() - started;

      try {
        // [1] 질문 → 벡터.
        //
        // 임베딩이 죽으면 검색을 시작할 수조차 없다. 생성 실패와 달리 돌려줄
        // 출처가 없으므로 degrade할 거리도 없다. 할 수 있는 최선은 빨리 실패해
        // 처리 슬롯을 놓아주는 것이다(재시도로 몇 초씩 붙잡고 있지 않고).
        let vector: number[];
        try {
          vector = await embedder.embedQuery(question);
        } catch (e) {
          if (e instanceof DependencyUnavailableError) {
            yield { type: "error", message: messages.embedUnavailable };
            return;
          }
          throw e; // 그 밖의 임베딩 실패는 아래 바깥 catch에서 처리한다.
        }

        // [2] 벡터 검색. scope를 반드시 함께 넘긴다(저장소가 이걸로 범위를 좁힌다).
        const chunks = await store.search(vector, policy.topK, scope);
        const topSimilarity = chunks[0]?.similarity ?? 0;
        const relevant = chunks.length > 0 && topSimilarity >= policy.threshold;

        // [3] 유사도가 낮으면 생성기를 아예 부르지 않고 거절한다.
        // 헛소리를 막는 동시에, 관련 없는 질문이 외부 API 비용을 쓰지 않게 한다.
        //
        // 단, 이미지가 붙어 있으면 거절하지 않는다. 이 문턱은 "근거 없는 답변"을
        // 막으려는 것인데, 이미지 질문은 근거가 이미지 자체에 있다 — 스크린샷을
        // 올리고 "이 오류 뭐야"라고 물으면 오류 문구는 이미지 안에 있지 질문
        // 텍스트에 없어서, 텍스트 유사도로 판정하면 정당한 질문이 전부 막힌다.
        // 대신 관련 문서를 못 찾았으면 발췌 없이 이미지만 보고 답하게 한다
        // (아래 contexts). 문서에 근거하지 않은 답이 나가는 게 아니라,
        // 근거가 문서에서 이미지로 바뀌는 것이다.
        if (!relevant && !image) {
          yield { type: "refusal", message: messages.refusal };
          log({
            question,
            answer: null,
            refused: true,
            topSimilarity,
            promptTokens: null,
            outputTokens: null,
            latencyMs: elapsed(),
          });
          return;
        }

        // 문턱을 넘었을 때만 발췌를 쓴다. 이미지 덕에 거절을 면한 경우까지
        // 무관한 청크를 끼워 보내면, 생성기가 그걸 근거랍시고 인용한다.
        const contexts = relevant ? chunks : [];

        // [4] 답변보다 근거를 먼저 보낸다.
        // 스트리밍 중에도 출처가 보이고, 아래에서 degrade되더라도 사용자에게
        // 최소한 이건 남는다. (발췌를 안 쓰는 경우에는 보낼 출처도 없다)
        if (relevant) {
          yield {
            type: "sources",
            sources: chunks.map((c, i) => ({
              index: i + 1,
              filename: c.filename,
              snippet: c.content.slice(0, policy.snippetLength),
              similarity: Math.round(c.similarity * 100) / 100,
            })),
          };
        }

        // [5] 생성.
        let answer = "";
        let promptTokens: number | null = null;
        let outputTokens: number | null = null;

        try {
          for await (const chunk of generator.stream(question, contexts, signal, image)) {
            // 떠난 사용자를 위해 토큰을 더 만들지 않는다. 여기서 빠져나가면
            // 생성기의 정리 코드가 돌면서 상류 호출도 함께 끊긴다.
            if (signal.aborted) break;
            if (chunk.text) {
              answer += chunk.text;
              yield { type: "delta", text: chunk.text };
            }
            if (chunk.usageMetadata) {
              promptTokens = chunk.usageMetadata.promptTokenCount ?? null;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? null;
            }
          }
        } catch (genErr) {
          // 사용자가 떠나서 우리가 끊은 것은 장애가 아니다. 조용히 끝낸다.
          if (signal.aborted) return;

          // 생성만 실패한 상황이다. 출처는 이미 보냈으니 사용자를 빈손으로
          // 두지 않고, 답변 생성만 포기한다(degradation).
          const unavailable = genErr instanceof DependencyUnavailableError;
          if (!unavailable) {
            console.error("LLM 생성 실패:", genErr instanceof Error ? genErr.message : genErr);
          }
          if (contexts.length > 0) {
            yield { type: "delta", text: messages.degraded };
            yield { type: "done", usage: { promptTokens: null, outputTokens: null } };
          } else {
            // 발췌 없이 이미지만 보고 답하던 중이었다. 이때는 보낸 출처가 없어서
            // "위 출처 문서를 확인해달라"는 degrade 문구가 거짓말이 된다 —
            // 돌려줄 부분 결과가 없으니 솔직하게 오류로 알린다.
            yield { type: "error", message: messages.error };
          }
          log({
            question,
            answer: unavailable ? "(degraded: breaker open)" : "(degraded: llm error)",
            refused: false,
            topSimilarity,
            promptTokens: null,
            outputTokens: null,
            latencyMs: elapsed(),
          });
          return;
        }

        // 중간에 끊긴 스트림은 성공이 아니다. done을 보내지 않고, 로그에도
        // 끊긴 답변임을 남긴다 — 이 프로젝트가 자기 상태를 판단하는 근거라서
        // 여기에 성공으로 기록되면 관측이 통째로 거짓말이 된다.
        if (signal.aborted) {
          log({
            question,
            answer: answer ? `${answer} (중단됨)` : "(중단됨)",
            refused: false,
            topSimilarity,
            promptTokens,
            outputTokens,
            latencyMs: elapsed(),
          });
          return;
        }

        yield { type: "done", usage: { promptTokens, outputTokens } };
        log({
          question,
          answer,
          refused: false,
          topSimilarity,
          promptTokens,
          outputTokens,
          latencyMs: elapsed(),
        });
      } catch (e) {
        // 여기 오는 건 검색·DB 같은 우리 쪽 문제이거나, 회로와 무관한 임베딩
        // 실패다. (생성 실패는 위에서 degrade로 처리되고 여기까지 오지 않는다.)
        if (!signal.aborted) {
          console.error("rag error:", e);
          yield { type: "error", message: messages.error };
        }
      }
    },
  };
}
