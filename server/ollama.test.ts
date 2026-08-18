// Ollama 클라이언트의 순수 부분 테스트.
//
// 서버 없이 검사할 수 있는 두 가지만 다룬다 — 스트림 한 줄의 해석과 임베딩
// 프롬프트 접두사. 특히 접두사는 틀려도 에러가 아니라 검색 품질 저하로만
// 나타나서(문서와 질문이 다른 요령으로 임베딩됨), 테스트가 아니면 못 잡는다.

import test from "node:test";
import assert from "node:assert/strict";
import { embedPrompt, parseChatLine } from "./ollama.ts";

test("본문 조각은 text로 온다", () => {
  const chunk = parseChatLine(
    JSON.stringify({ message: { role: "assistant", content: "7일 " }, done: false })
  );
  assert.deepEqual(chunk, { text: "7일 " });
});

test("마지막 줄은 토큰 사용량으로 바뀐다", () => {
  const chunk = parseChatLine(
    JSON.stringify({ done: true, prompt_eval_count: 900, eval_count: 12 })
  );
  assert.deepEqual(chunk, {
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 12 },
  });
});

test("빈 줄과 빈 내용은 조용히 버린다", () => {
  assert.equal(parseChatLine(""), null);
  assert.equal(parseChatLine("  \n"), null);
  // keep-alive 성격의 내용 없는 조각 — text: ""를 올려보내면 코어가 빈 delta를 만든다
  assert.equal(
    parseChatLine(JSON.stringify({ message: { content: "" }, done: false })),
    null
  );
});

test("스트림 도중의 에러 줄은 throw로 바뀐다", () => {
  // Ollama는 에러도 정상 응답과 같은 모양(한 줄 JSON)으로 보낸다.
  // 던지지 않으면 에러가 조용히 버려지고 답변이 중간에서 그냥 멈춘다.
  assert.throws(
    () => parseChatLine(JSON.stringify({ error: "model not found" })),
    /model not found/
  );
});

test("임베딩 접두사는 모델 계열을 따라간다", () => {
  // EmbeddingGemma: Google 문서의 권장 프롬프트 형식.
  assert.equal(
    embedPrompt("embeddinggemma", "query", "환불 되나요"),
    "task: search result | query: 환불 되나요"
  );
  assert.equal(
    embedPrompt("embeddinggemma:300m", "document", "환불은 7일 이내"),
    "title: none | text: 환불은 7일 이내"
  );

  // nomic-embed-text 계열.
  assert.equal(embedPrompt("nomic-embed-text", "query", "질문"), "search_query: 질문");
  assert.equal(
    embedPrompt("nomic-embed-text:v1.5", "document", "본문"),
    "search_document: 본문"
  );

  // 모르는 모델은 손대지 않는다 — 접두사를 지어내 붙이는 게 더 나쁘다.
  assert.equal(embedPrompt("bge-m3", "query", "질문"), "질문");
});
