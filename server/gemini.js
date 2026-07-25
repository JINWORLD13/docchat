import { GoogleGenAI } from "@google/genai";
import { getCached, setCached } from "./cache.js";
import { faults } from "./faults.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const EMBEDDING_MODEL = "gemini-embedding-001";
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash";

// pgvector 컬럼 차원과 맞춰야 한다 (schema.sql의 vector(768))
export const EMBEDDING_DIM = 768;

// LLM_PROVIDER=mock 이면 Gemini를 부르지 않고 가짜 벡터/응답을 돌려준다.
// 부하 테스트에서 진짜 병목(외부 LLM API)을 빼고, 내가 통제하는 부분
// (HTTP·검색·캐시·풀)의 성능만 따로 재기 위해서다. Gemini 무료 티어를
// 부하로 두들기면 rate limit에 바로 걸려서 애초에 측정이 안 되기도 한다.
const PROVIDER = process.env.LLM_PROVIDER || "gemini";

// 텍스트 하나로 결정적인 768차원 벡터를 만든다(같은 글 → 같은 벡터).
// 시드 기반 LCG라 Math.random 없이도 재현 가능하다. 검색 품질은 부하 테스트에서
// 중요하지 않으니, 빠르고 일관적이기만 하면 된다.
function mockVector(text, dim = EMBEDDING_DIM) {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    v[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return v;
}

async function* mockStream() {
  for (const part of ["부하 ", "테스트용 ", "모의 응답입니다 [1]."]) {
    yield { text: part };
  }
  yield { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 12 } };
}

// 일시적 오류(429 rate limit, 5xx 서버 장애)는 잠깐 기다렸다 다시 부르면
// 대부분 성공한다. 반대로 400/404 같은 건 재시도해도 소용없으니 바로 던진다.
const RETRYABLE = new Set([429, 500, 503, 504]);

async function withRetry(fn, label) {
  const delays = [500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!RETRYABLE.has(e?.status) || attempt >= delays.length) throw e;
      const wait = delays[attempt];
      console.warn(`${label} ${e.status} - ${wait}ms 후 재시도 (${attempt + 1}/${delays.length})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// 문서 저장용과 질문용은 taskType이 다르다.
// 같은 텍스트라도 용도에 맞는 taskType을 줘야 검색 품질이 좋아진다.
export async function embedTexts(texts, taskType = "RETRIEVAL_DOCUMENT") {
  if (PROVIDER === "mock") return texts.map((t) => mockVector(t));

  const result = await withRetry(
    () =>
      ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts,
        config: { taskType, outputDimensionality: EMBEDDING_DIM },
      }),
    "임베딩"
  );
  return result.embeddings.map((e) => e.values);
}

export async function embedQuery(text) {
  // 같은 질문이면 캐시된 벡터를 그대로 쓴다 → 임베딩 API 호출을 건너뜀.
  // 문서 저장(RETRIEVAL_DOCUMENT)은 한 번뿐이라 캐싱 이득이 없고,
  // 질문(RETRIEVAL_QUERY)은 반복되므로 여기만 캐싱한다.
  const key = "q:" + text;
  const cached = getCached(key);
  if (cached) return cached;

  const [vector] = await embedTexts([text], "RETRIEVAL_QUERY");
  setCached(key, vector);
  return vector;
}

export async function streamAnswer(question, contexts) {
  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (출처: ${c.filename})\n${c.content}`)
    .join("\n\n");

  const prompt = `당신은 사용자가 업로드한 문서를 근거로 답하는 어시스턴트입니다.

규칙:
- 아래 발췌 내용만 근거로 답합니다. 발췌에 없는 내용은 추측하지 말고 문서에 없다고 답하세요.
- 근거로 사용한 발췌 번호를 문장 끝에 [1], [2] 형태로 표시하세요.
- 한국어로 간결하게 답하세요.
- 굵게(**), 제목(#), 별표 목록(*) 같은 마크다운 서식은 쓰지 마세요.
  평범한 문장으로 답하고, 항목을 나열할 땐 줄바꿈만 쓰세요.

발췌:
${contextBlock}

질문: ${question}`;

  // 장애 주입 스위치. 대시보드 버튼으로 faults.llmFail을 켜면 생성이 실패한다.
  // 죽은 의존성이 타임아웃까지 매달리는 상황을 흉내내려고 잠깐 지연 후 던진다.
  // 이래야 회로차단기가 열렸을 때(즉시 실패)와 안 열렸을 때(느린 실패)의
  // 지연 차이가 드러난다. degradation·circuit breaker 재현용.
  if (faults.llmFail) {
    await new Promise((r) => setTimeout(r, 300));
    const e = new Error("mock LLM 장애");
    e.status = 503;
    throw e;
  }

  if (PROVIDER === "mock") return mockStream();

  // 스트림을 여는 것까지만 재시도한다. 일단 토큰이 흘러나오기 시작하면
  // (chat.js에서 for await로 소비) 중간에 재시도할 수 없다.
  return withRetry(
    () => ai.models.generateContentStream({ model: CHAT_MODEL, contents: prompt }),
    "생성"
  );
}
