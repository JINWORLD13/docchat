import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./chunk.js";

test("짧은 글은 청크 하나로 나온다", () => {
  assert.deepEqual(chunkText("안녕하세요 반갑습니다", 200, 40), [
    "안녕하세요 반갑습니다",
  ]);
});

test("긴 글은 겹치면서 나뉜다", () => {
  const words = Array.from({ length: 450 }, (_, i) => `단어${i}`);
  const chunks = chunkText(words.join(" "), 200, 40);

  assert.equal(chunks.length, 3);
  // 앞 청크의 마지막 40어절 == 다음 청크의 처음 40어절
  const first = chunks[0].split(" ");
  const second = chunks[1].split(" ");
  assert.deepEqual(first.slice(-40), second.slice(0, 40));
});

test("빈 문자열은 빈 배열", () => {
  assert.deepEqual(chunkText(""), []);
});
