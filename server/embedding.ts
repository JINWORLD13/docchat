// 임베딩 공급자 선택 + 질문 벡터 캐시.
//
// 생성(답변)은 어댑터 체인으로 폴백하지만(adapters/generator.ts), 임베딩은
// 일부러 폴백을 만들지 않았다. 문서를 임베딩한 모델과 질문을 임베딩하는 모델이
// 다르면 두 벡터는 서로 다른 공간의 좌표라 유사도 계산이 무의미해진다 —
// 에러도 안 나고 그냥 모든 질문이 임계값 미달로 나와 전부 거절된다.
// "임베딩이 죽으면 다른 모델로"는 그래서 복구가 아니라 조용한 고장이다.
// 임베딩 공급자는 EMBEDDER로 한 번 고르는 것이고, 바꾸면 문서를 다시
// 업로드해야 한다(기존 청크 벡터가 전부 옛 모델의 좌표라서).
//
// 이 파일이 필요한 이유는 임베딩을 부르는 곳이 둘이기 때문이다 —
// 질문(어댑터)과 문서 업로드(routes/documents.ts). 선택 로직이 한쪽에만 있으면
// 질문은 Ollama로, 문서는 Gemini로 임베딩하는 바로 그 사고가 난다.

import { getCached, setCached } from "./cache.ts";
import * as gemini from "./gemini.ts";
import * as ollama from "./ollama.ts";

// LLM_PROVIDER=mock(부하 테스트)이면 공급자 선택을 무시하고 gemini.ts로 보낸다.
// 그 안의 mock 분기가 결정적 가짜 벡터를 돌려주므로, Ollama가 없는 CI에서도
// start:mock과 loadtest가 그대로 돈다.
const EMBEDDER =
  process.env.LLM_PROVIDER === "mock" ? "gemini" : process.env.EMBEDDER || "gemini";

// 오타는 기동 시점에 죽인다. "ollma"라고 적었는데 조용히 gemini로 돌면,
// 로컬로 돈다고 믿는 동안 질문이 전부 외부로 나간다.
if (EMBEDDER !== "gemini" && EMBEDDER !== "ollama") {
  throw new Error(`EMBEDDER는 gemini 또는 ollama여야 합니다: ${EMBEDDER}`);
}

// 캐시 키에 들어갈 공급자·모델 식별자. 모델이 다르면 같은 질문도 다른 벡터라,
// 이게 키에 없으면 EMBEDDER를 바꾼 뒤 남의 공간 벡터를 캐시에서 돌려주게 된다.
const MODEL_ID =
  EMBEDDER === "ollama" ? `ollama/${ollama.EMBED_MODEL}` : `gemini/${gemini.EMBEDDING_MODEL}`;

// pgvector 컬럼은 vector(768) 고정이다(schema.sql). Gemini는 outputDimensionality로
// 768을 강제하지만 Ollama는 모델이 주는 차원을 그대로 돌려주므로, 1024차원 모델
// (bge-m3 등)을 골라두면 여기까지는 멀쩡히 오고 DB insert에서야 터진다.
// 그때는 에러 문구가 SQL 얘기라 원인(모델 선택)을 가리키지 않는다. 여기서 잡는다.
function assertDimension(vectors: number[][]): number[][] {
  for (const v of vectors) {
    if (v.length !== gemini.EMBEDDING_DIM) {
      throw new Error(
        `임베딩 차원 불일치: ${MODEL_ID}가 ${v.length}차원을 돌려줬습니다. ` +
          `schema.sql의 vector(${gemini.EMBEDDING_DIM})와 맞는 모델을 쓰거나 스키마를 바꿔주세요.`
      );
    }
  }
  return vectors;
}

// 문서 저장용. 업로드 경로(routes/documents.ts)가 쓴다.
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const vectors =
    EMBEDDER === "ollama"
      ? await ollama.embedTexts(texts, "document")
      : await gemini.embedTexts(texts, "RETRIEVAL_DOCUMENT");
  return assertDimension(vectors);
}

// 질문용. 같은 질문이면 캐시된 벡터를 그대로 쓴다 → 임베딩 호출을 건너뜀.
// 문서 저장은 한 번뿐이라 캐싱 이득이 없고, 질문은 반복되므로 여기만 캐싱한다.
export async function embedQuery(text: string): Promise<number[]> {
  const key = `${MODEL_ID}:q:${text}`;
  const cached = getCached<number[]>(key);
  if (cached) return cached;

  const [vector] = await (EMBEDDER === "ollama"
    ? ollama.embedTexts([text], "query")
    : gemini.embedTexts([text], "RETRIEVAL_QUERY"));
  if (!vector) throw new Error("질문 임베딩을 만들지 못했습니다.");
  assertDimension([vector]);

  setCached(key, vector);
  return vector;
}
