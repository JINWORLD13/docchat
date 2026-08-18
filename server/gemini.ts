import { GoogleGenAI } from "@google/genai";
import { faults } from "./faults.ts";
import { buildAnswerPrompt } from "./prompt.ts";
import type { AnswerChunk, QuestionImage, RetrievedChunk } from "./types.ts";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// embedding.ts가 캐시 키에 쓴다 — 공급자·모델이 다르면 같은 질문이라도
// 다른 벡터라, 키에 모델이 안 들어가면 남의 공간 벡터를 돌려주게 된다.
export const EMBEDDING_MODEL = "gemini-embedding-001";
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
function mockVector(text: string, dim: number = EMBEDDING_DIM): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    v[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return v;
}

async function* mockStream(): AsyncGenerator<AnswerChunk> {
  for (const part of ["부하 ", "테스트용 ", "모의 응답입니다 [1]."]) {
    yield { text: part };
  }
  yield { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 12 } };
}

// catch로 잡히는 값은 unknown이다(무엇이든 throw될 수 있으므로).
// 그래서 .status를 바로 읽을 수 없고, 실제로 숫자 status가 붙어 있는지
// 확인한 뒤에만 꺼낸다. JS일 때 e?.status로 뭉개던 부분을 명시적으로 만든 곳.
function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

// 일시적 오류(429 rate limit, 5xx 서버 장애)는 잠깐 기다렸다 다시 부르면
// 대부분 성공한다. 반대로 400/404 같은 건 재시도해도 소용없으니 바로 던진다.
const RETRYABLE = new Set([429, 500, 503, 504]);

// 외부 호출 하나가 매달릴 수 있는 최대 시간.
const STREAM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const delays = [500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e instanceof Error ? statusOf(e) : undefined;
      // 대기 시간이 더 없다는 것 = 재시도 횟수를 다 썼다는 뜻.
      // 남은 시도 횟수를 따로 세지 않고 배열 하나로 두 조건을 함께 표현한다.
      const wait = delays[attempt];
      if (status === undefined || !RETRYABLE.has(status) || wait === undefined) throw e;
      // 대기에 지터(무작위 흔들기)를 섞는다.
      // 없으면 같은 순간 실패한 요청들이 정확히 같은 시각에 함께 재시도해서,
      // 이제 막 살아나려는 API를 8건이 동시에 다시 두들긴다(thundering herd).
      // 재시도의 목적은 "부하를 흩는 것"이기도 하다.
      const jittered = wait / 2 + Math.random() * wait;
      console.warn(`${label} ${status} - ${Math.round(jittered)}ms 후 재시도 (${attempt + 1}/${delays.length})`);
      await new Promise((r) => setTimeout(r, jittered));
    }
  }
}

// 문서 저장용과 질문용은 taskType이 다르다.
// 같은 텍스트라도 용도에 맞는 taskType을 줘야 검색 품질이 좋아진다.
export async function embedTexts(
  texts: string[],
  taskType = "RETRIEVAL_DOCUMENT"
): Promise<number[][]> {
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

  // SDK 타입상 embeddings와 values는 둘 다 optional이다. JS로 짤 땐 그냥
  // .map(e => e.values)로 넘겼는데, 값이 비어 있으면 undefined가 그대로 DB까지
  // 흘러가 한참 뒤에 터진다. 없으면 여기서 즉시 실패시키는 게 낫다.
  if (!result.embeddings) throw new Error("임베딩 응답에 embeddings가 없습니다.");
  return result.embeddings.map((e) => {
    if (!e.values) throw new Error("임베딩 응답에 벡터 값이 없습니다.");
    return e.values;
  });
}

// 질문 임베딩(+캐시)은 embedding.ts로 옮겼다 — 공급자(Gemini·Ollama)를
// 고르는 일과 캐시는 벤더 파일이 아니라 그 라우팅 층의 몫이라서다.

export async function streamAnswer(
  question: string,
  contexts: RetrievedChunk[],
  signal?: AbortSignal,
  image?: QuestionImage
): Promise<AsyncIterable<AnswerChunk>> {
  // 프롬프트는 생성기들이 공유한다(prompt.ts). 로컬 모델로 폴백해도
  // 같은 규칙(근거·인용·형식)으로 답해야 하기 때문이다.
  const prompt = buildAnswerPrompt(question, contexts, image !== undefined);

  // 장애 주입 스위치. 대시보드 버튼으로 faults.llmFail을 켜면 생성이 실패한다.
  // 죽은 의존성이 타임아웃까지 매달리는 상황을 흉내내려고 잠깐 지연 후 던진다.
  // 이래야 회로차단기가 열렸을 때(즉시 실패)와 안 열렸을 때(느린 실패)의
  // 지연 차이가 드러난다. degradation·circuit breaker 재현용.
  if (faults.llmFail) {
    await new Promise((r) => setTimeout(r, 300));
    throw Object.assign(new Error("mock LLM 장애"), { status: 503 });
  }

  if (PROVIDER === "mock") return mockStream();

  // 이미지는 base64 inline 파트로 프롬프트와 함께 보낸다.
  // Buffer.from(뷰)가 아니라 (buffer, offset, length)로 만드는 이유:
  // 앞의 모양은 바이트를 복사하고, 이 모양은 같은 메모리를 그대로 본다.
  // 어차피 base64 문자열로 바뀌는 순간 복사가 한 번 일어나므로 그 앞의
  // 복사는 순수한 낭비다(최대 2MB).
  const contents = image
    ? [
        { text: prompt },
        {
          inlineData: {
            mimeType: image.mime,
            data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64"),
          },
        },
      ]
    : prompt;

  // 스트림을 여는 것까지만 재시도한다. 일단 토큰이 흘러나오기 시작하면
  // (chat.ts에서 for await로 소비) 중간에 재시도할 수 없다.
  //
  // abortSignal과 timeout을 같이 준다.
  // - abortSignal: 사용자가 떠나면 상류 생성을 실제로 끊는다. 우리 쪽 for await를
  //   빠져나오는 것만으로는 이미 열린 응답이 닫히지 않아 생성이 끝까지 돌고
  //   토큰이 과금된다.
  // - timeout: 상류가 응답도 오류도 주지 않고 멎는 경우를 막는다. 이게 없으면
  //   기본값(약 300초)까지 매달리는데, 그동안 처리 슬롯 하나가 묶인다.
  //   슬롯 8개가 그렇게 묶이면 아무것도 "실패"하지 않은 채로 전원이 429를 받고,
  //   실패가 없으니 회로도 안 열린다 — 가장 알아채기 어려운 형태의 마비다.
  return withRetry(
    () =>
      ai.models.generateContentStream({
        model: CHAT_MODEL,
        contents,
        config: { abortSignal: signal, httpOptions: { timeout: STREAM_TIMEOUT_MS } },
      }),
    "생성"
  );
}
