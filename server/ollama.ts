// Ollama(온디바이스 모델) 클라이언트 — gemini.ts의 로컬 짝.
//
// 왜 Ollama인가: 로컬 모델 서빙의 사실상 표준이고, HTTP API가 단순해서
// SDK 없이 fetch로 끝난다. 의존성을 하나 더 들이면 그 버전·취약점·타입을
// 계속 따라다녀야 하는데, 여기서 쓰는 건 엔드포인트 두 개뿐이다.
//
// 재시도를 일부러 안 한다(gemini.ts의 withRetry와 다른 점).
// 클라우드 API의 429/5xx는 잠깐 기다리면 풀리는 혼잡이지만, 로컬 서버의
// 실패는 "안 떠 있음(즉시 거절)" 아니면 "멈춤(타임아웃)"이다. 둘 다 기다린다고
// 복구되지 않고, 재시도하는 시간만큼 보루(Gemini)로 넘어가는 게 늦어진다.
// 뒤에 폴백이 있는 1차 공급자는 빨리 실패하는 게 일이다.

import { faults } from "./faults.ts";
import { buildAnswerPrompt } from "./prompt.ts";
import type { AnswerChunk, QuestionImage, RetrievedChunk } from "./types.ts";

const BASE_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "gemma3:4b";
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "embeddinggemma";

// 스트림 전체에 거는 상한. 로컬 추론은 기계에 따라 느릴 수 있어 빡빡하게
// 잡으면 멀쩡한 답변을 끊는다. 대신 진짜 멈춤이 반복되면 회로가 열려
// (adapters/generator.ts) 다음 요청부터는 기다리지 않고 보루로 간다.
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60_000);

// 임베딩 모델별 프롬프트 접두사.
//
// 검색용 임베딩 모델들은 "이 텍스트가 문서인지 질문인지"를 접두사로 받는다.
// Gemini는 taskType 파라미터로 받아서 문제가 없는데, Ollama API에는 그런
// 자리가 없어 텍스트에 직접 붙여야 한다. 안 붙이면 조용히 동작은 하지만
// 문서와 질문이 다른 요령으로 임베딩돼 검색 품질이 떨어진다 — 실패가 아니라
// 품질 저하라서 알아채기 어려운 종류다.
export type EmbedKind = "document" | "query";

export function embedPrompt(model: string, kind: EmbedKind, text: string): string {
  // EmbeddingGemma가 학습된 형식 (Google 문서의 권장 프롬프트).
  if (model.startsWith("embeddinggemma")) {
    return kind === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  }
  // nomic-embed-text 계열의 형식.
  if (model.startsWith("nomic-embed")) {
    return kind === "query" ? `search_query: ${text}` : `search_document: ${text}`;
  }
  // 모르는 모델은 그대로 보낸다. 접두사를 지어내서 붙이는 게 더 나쁘다.
  return text;
}

// 응답이 JSON 에러({ error: "..." })일 수 있어 상태와 함께 읽는다.
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {
    // 본문이 JSON이 아니면 상태 코드만으로 만든다.
  }
  return `HTTP ${res.status}`;
}

export async function embedTexts(texts: string[], kind: EmbedKind): Promise<number[][]> {
  const res = await fetch(`${BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts.map((t) => embedPrompt(EMBED_MODEL, kind, t)),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama 임베딩 실패: ${await readError(res)}`);

  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error("Ollama 임베딩 응답에 벡터가 없습니다.");
  }
  return data.embeddings;
}

// NDJSON 한 줄을 AnswerChunk로. 스트림 파싱에서 실수하기 쉬운 부분만 순수
// 함수로 떼어 테스트를 붙였다(ollama.test.ts).
export function parseChatLine(line: string): AnswerChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const data = JSON.parse(trimmed) as {
    error?: string;
    message?: { content?: string };
    done?: boolean;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  // 스트림 도중의 에러도 정상 응답과 같은 모양(한 줄 JSON)으로 온다.
  if (data.error) throw new Error(`Ollama 생성 실패: ${data.error}`);

  if (data.done) {
    return {
      usageMetadata: {
        promptTokenCount: data.prompt_eval_count,
        candidatesTokenCount: data.eval_count,
      },
    };
  }
  const text = data.message?.content;
  return text ? { text } : null;
}

export async function* streamAnswer(
  question: string,
  contexts: RetrievedChunk[],
  signal: AbortSignal,
  image?: QuestionImage
): AsyncIterable<AnswerChunk> {
  // 대시보드의 장애 주입 스위치. gemini.ts에도 같은 검사가 있다 — 한쪽에만
  // 두면 체인 구성에 따라 "LLM 장애" 버튼이 아무 일도 안 하게 된다.
  if (faults.llmFail) {
    await new Promise((r) => setTimeout(r, 300));
    throw Object.assign(new Error("mock LLM 장애"), { status: 503 });
  }

  const prompt = buildAnswerPrompt(question, contexts, image !== undefined);

  const message: { role: "user"; content: string; images?: string[] } = {
    role: "user",
    content: prompt,
  };
  if (image) {
    // gemini.ts와 같은 이유로 복사 없이 base64로 만든다.
    message.images = [
      Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64"),
    ];
  }

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, messages: [message], stream: true }),
    // 사용자가 떠나면 끊고(signal), 로컬 서버가 멈춰도 상한에서 끊는다(timeout).
    // 이 상한이 없으면 멈춘 로컬 서버에 처리 슬롯이 하나씩 묶인다 —
    // gemini.ts의 STREAM_TIMEOUT_MS와 같은 이유.
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`Ollama 생성 실패: ${await readError(res)}`);
  if (!res.body) throw new Error("Ollama 응답 스트림을 열 수 없습니다.");

  // NDJSON: 한 줄이 이벤트 하나. 조각이 줄 중간에서 끊길 수 있어 남겨둔다.
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of res.body) {
    buffer += decoder.decode(value as Uint8Array, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const chunk = parseChatLine(line);
      if (chunk) yield chunk;
    }
  }
  const last = parseChatLine(buffer);
  if (last) yield last;
}
