// 조립(composition root) — RAG 코어가 어떤 부품으로 돌지 정하는 유일한 곳.
//
// 원래 routes/chat.ts 안에 있었는데, 전송이 둘(웹 SSE, 카카오톡 스킬)이 되면서
// 뺐다. 각 전송이 자기 엔진을 따로 조립하면 "웹은 로컬 우선인데 카카오는
// Gemini만"처럼 조용히 어긋난 두 시스템이 된다. 어느 전송으로 들어와도
// 같은 정책·같은 부품으로 도는 게 이 앱의 정체성이라 조립은 한 번만 한다.
//
// 임베딩 모델을 바꾸거나(EMBEDDER) 생성기를 로컬 우선으로 돌리는 것도
// (GENERATORS) 여기 닿는 env 스위치를 고치는 일이 된다. 리랭커를 끼우는 것도
// 마찬가지로 이 목록을 고치는 일이다.

import { createRagEngine } from "./rag/engine.ts";
import { queryEmbedder } from "./adapters/embedder.ts";
import { pgVectorStore } from "./adapters/store.ts";
import { geminiGenerator, ollamaGenerator, withFallback } from "./adapters/generator.ts";
import { pgQueryLogger } from "./adapters/logger.ts";
import type { AnswerGenerator, Scope } from "./types.ts";

// 생성기 체인. GENERATORS="ollama,gemini"처럼 적으면 앞에서부터 시도하고,
// 앞이 (첫 토큰 전에) 실패하면 다음으로 넘어간다 — 온디바이스 우선, 클라우드는
// 최후의 보루라는 구성이 env 한 줄이 된다. 기본은 gemini 하나(지금까지와 동일).
//
// LLM_PROVIDER=mock(부하 테스트)이면 체인을 무시하고 gemini 어댑터만 쓴다 —
// 그 안의 mock 분기가 가짜 스트림을 돌려주므로 Ollama 없는 환경에서도 돈다.
// (임베딩 공급자는 여기가 아니라 embedding.ts가 고른다. 생성과 달리 임베딩은
//  문서와 질문이 같은 모델이어야 해서 체인이 아니라 고정 스위치다.)
const GENERATORS: Record<string, AnswerGenerator> = {
  gemini: geminiGenerator,
  ollama: ollamaGenerator,
};

function generatorFromEnv(): AnswerGenerator {
  const spec = process.env.LLM_PROVIDER === "mock" ? "gemini" : process.env.GENERATORS || "gemini";
  const chain = spec.split(",").map((name) => {
    const found = GENERATORS[name.trim()];
    // 오타는 기동 시점에 죽인다. 조용히 빼고 돌면 "로컬로 돈다"고 믿는 동안
    // 질문이 전부 클라우드로 나간다 (embedding.ts와 같은 기준).
    if (!found) throw new Error(`GENERATORS에 모르는 공급자: ${name} (gemini | ollama)`);
    return found;
  });
  // 오른쪽부터 접는다: [a, b, c] → a 실패 시 b, b 실패 시 c.
  return chain.reduceRight((backup, primary) => withFallback(primary, backup));
}

export const engine = createRagEngine({
  embedder: queryEmbedder,
  store: pgVectorStore,
  generator: generatorFromEnv(),
  logger: pgQueryLogger,
  policy: { threshold: Number(process.env.SIMILARITY_THRESHOLD || 0.62) },
});

// 열람 범위에 제한이 없다 — 로그인한 사람은 같은 문서 코퍼스를 본다.
//
// 이제 로그인은 있다(auth.ts의 requireLogin이 질문·문서 경로를 막는다).
// 그런데도 이 값이 여전히 null인 이유는, 인증과 인가가 다른 문제라서다.
// "들어온 사람인가"는 세션으로 답할 수 있지만 "이 문서를 볼 수 있는가"는
// documents에 소유자·그룹 컬럼이 있어야 답할 수 있고, 그 컬럼이 아직 없다.
// 없는 필터를 있는 척하지 않으려고 저장소 어댑터가 범위 검색 자체를 막아둔
// 것과 같은 태도다(adapters/store.ts).
//
// 그 컬럼이 생기면 이 상수는 "요청에서 꺼낸 사용자의 범위"로 바뀐다 —
// 바뀌는 곳은 여기 한 줄과 그걸 넘기는 전송 계층이고, 실제로 걸러내는 건
// 저장소 어댑터다.
export const UNRESTRICTED: Scope = { groups: null };
