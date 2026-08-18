// AnswerGenerator 포트의 DocChat 구현 — Gemini·Ollama 생성 + 회로 차단기 + 폴백.
//
// 회로 판정 시점이 미묘해서 그대로 옮겨둔다.
// - 스트림을 끝까지 소비했을 때만 성공이다. 열리기만 한 스트림은 성공이 아니다.
// - 사용자가 떠나서 끊긴 것은 실패가 아니다. 이걸 실패로 세면 새로고침 몇 번에
//   회로가 열려 멀쩡한 API를 차단하게 된다.
// 코어가 중간에 for-await를 빠져나가면 이 제너레이터는 yield 지점에서 닫히므로
// catch도 성공 처리도 타지 않는다 — 위 두 규칙이 그때 자동으로 지켜진다.

import * as gemini from "../gemini.ts";
import * as ollama from "../ollama.ts";
import * as breaker from "../breaker.ts";
import type { Breaker } from "../breaker.ts";
import {
  DependencyUnavailableError,
  type AnswerChunk,
  type AnswerGenerator,
  type QuestionImage,
  type RetrievedChunk,
} from "../rag/types.ts";

// Gemini와 Ollama의 어댑터는 회로 판정 규칙이 완전히 같아서 한 곳에 두고
// "무엇을 부를지"와 "어느 회로에 기록할지"만 바꾼다.
type StreamFn = (
  question: string,
  contexts: RetrievedChunk[],
  signal: AbortSignal,
  image?: QuestionImage
) => Promise<AsyncIterable<AnswerChunk>> | AsyncIterable<AnswerChunk>;

function breakered(name: string, circuit: Breaker, open: StreamFn): AnswerGenerator {
  return {
    async *stream(question, contexts, signal, image): AsyncIterable<AnswerChunk> {
      // 최근 연속 장애면 부르지도 않는다. 받는 쪽(폴백 체인 또는 코어)이
      // 이걸 다음 공급자 시도 또는 degrade로 바꾼다.
      if (circuit.isOpen()) throw new DependencyUnavailableError(name);

      try {
        const stream = await open(question, contexts, signal, image);
        for await (const chunk of stream) {
          yield chunk;
        }
        if (!signal.aborted) circuit.onSuccess();
      } catch (e) {
        if (!signal.aborted) circuit.onFailure();
        throw e;
      }
    },
  };
}

export const geminiGenerator: AnswerGenerator = breakered(
  "generation",
  breaker.llm,
  (q, c, s, img) => gemini.streamAnswer(q, c, s, img)
);

// 이미지 질문을 로컬로 보낼지. 비전 없는 모델에 이미지를 보내면 Ollama는
// 에러가 아니라 "이미지를 무시한 답"을 돌려준다 — 안 본 사진을 봤다는 듯
// 답하는 최악의 실패라, 명시적으로 켠 경우에만 로컬로 보낸다.
const OLLAMA_VISION = process.env.OLLAMA_VISION === "1";

const ollamaBase = breakered("local-generation", breaker.local, (q, c, s, img) =>
  ollama.streamAnswer(q, c, s, img)
);

export const ollamaGenerator: AnswerGenerator = {
  stream(question, contexts, signal, image): AsyncIterable<AnswerChunk> {
    // 회로보다 먼저 확인한다. 이건 장애가 아니라 능력의 문제라 실패로 세면
    // 이미지 질문 몇 개가 로컬 회로를 열어 텍스트 질문까지 보루로 보낸다.
    if (image && !OLLAMA_VISION) {
      throw new DependencyUnavailableError("local-vision");
    }
    return ollamaBase.stream(question, contexts, signal, image);
  },
};

// 폴백 체인: primary가 첫 조각을 내기 전에 실패하면 backup으로 넘어간다.
//
// "첫 조각 전"이 경계인 이유: 이미 토큰이 사용자 화면에 흘러간 뒤에 갈아타면
// 다른 모델이 처음부터 다시 쓴 답이 이어붙어, 앞부분이 중복되고 문체가 바뀐
// 괴물이 된다. 그때는 여기서 갈아타지 않고 코어의 degrade(출처는 남기고 생성만
// 포기)가 처리하게 던진다. 사용자가 떠난 경우(signal.aborted)도 넘어가지 않는다 —
// 아무도 안 볼 답을 보루까지 동원해 만들 이유가 없다.
export function withFallback(primary: AnswerGenerator, backup: AnswerGenerator): AnswerGenerator {
  return {
    async *stream(question, contexts, signal, image): AsyncIterable<AnswerChunk> {
      let yielded = false;
      try {
        for await (const chunk of primary.stream(question, contexts, signal, image)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (e) {
        if (yielded || signal.aborted) throw e;
        // 회로가 미리 끊은 것(DependencyUnavailableError)은 예상된 경로라
        // 조용히 넘어가고, 실제 실패는 원인을 남긴다 — 로컬이 왜 죽는지는
        // 이 로그로만 알 수 있다.
        if (!(e instanceof DependencyUnavailableError)) {
          console.warn("1차 생성 실패, 다음 공급자로 폴백:", e instanceof Error ? e.message : e);
        }
      }
      yield* backup.stream(question, contexts, signal, image);
    },
  };
}
