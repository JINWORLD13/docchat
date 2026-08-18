// 생성기 폴백 체인 테스트.
//
// 폴백의 위험은 "넘어가면 안 되는 순간에 넘어가는 것"이다 — 이미 절반쯤
// 흘러간 답 뒤에 다른 모델이 처음부터 쓴 답이 이어붙거나, 떠난 사용자를 위해
// 보루까지 동원해 토큰을 만드는 것. 그 경계(첫 조각 전/후, abort)를 못박는다.

import test from "node:test";
import assert from "node:assert/strict";
import { ollamaGenerator, withFallback } from "./generator.ts";
import {
  DependencyUnavailableError,
  type AnswerChunk,
  type AnswerGenerator,
  type QuestionImage,
} from "../rag/types.ts";

const IMAGE: QuestionImage = { mime: "image/png", data: new Uint8Array([1]) };

function okGenerator(label: string, calls: string[]): AnswerGenerator {
  return {
    async *stream(_q, _c, _s, image): AsyncIterable<AnswerChunk> {
      calls.push(label + (image ? "+image" : ""));
      yield { text: `${label} 답변` };
    },
  };
}

// n개 조각을 내보낸 뒤 죽는 생성기. n=0이면 첫 조각 전에 죽는다.
function dyingGenerator(chunksBeforeDeath: number, calls: string[]): AnswerGenerator {
  return {
    async *stream(): AsyncIterable<AnswerChunk> {
      calls.push("primary");
      for (let i = 0; i < chunksBeforeDeath; i++) yield { text: `조각${i}` };
      throw new Error("로컬 죽음");
    },
  };
}

async function collect(stream: AsyncIterable<AnswerChunk>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) if (chunk.text) out.push(chunk.text);
  return out;
}

// console.warn(폴백 로그)이 테스트 출력을 어지럽히지 않게 잠깐 막는다.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

test("1차가 첫 조각 전에 죽으면 2차가 이어받는다", async () => {
  const calls: string[] = [];
  const chained = withFallback(dyingGenerator(0, calls), okGenerator("보루", calls));

  const texts = await quietly(() =>
    collect(chained.stream("질문", [], new AbortController().signal))
  );

  assert.deepEqual(texts, ["보루 답변"]);
  assert.deepEqual(calls, ["primary", "보루"]);
});

test("이미 조각이 나갔으면 갈아타지 않고 실패를 올린다", async () => {
  const calls: string[] = [];
  const chained = withFallback(dyingGenerator(2, calls), okGenerator("보루", calls));

  const received: string[] = [];
  await assert.rejects(async () => {
    for await (const chunk of chained.stream("질문", [], new AbortController().signal)) {
      if (chunk.text) received.push(chunk.text);
    }
  }, /로컬 죽음/);

  // 앞부분은 이미 사용자에게 갔고, 보루는 불리지 않았다 — 이 실패는 코어의
  // degrade(출처는 남기고 생성만 포기)가 처리할 몫이다.
  assert.deepEqual(received, ["조각0", "조각1"]);
  assert.ok(!calls.includes("보루"));
});

test("사용자가 떠났으면 보루를 부르지 않는다", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const primary: AnswerGenerator = {
    async *stream(): AsyncIterable<AnswerChunk> {
      calls.push("primary");
      controller.abort(); // 첫 조각을 내기 전에 사용자가 떠났다
      throw new Error("abort로 끊김");
    },
  };
  const chained = withFallback(primary, okGenerator("보루", calls));

  await assert.rejects(() => collect(chained.stream("질문", [], controller.signal)));
  assert.ok(!calls.includes("보루"), "아무도 안 볼 답을 보루까지 동원해 만들면 안 된다");
});

test("회로가 미리 끊은 것(DependencyUnavailable)도 조용히 다음으로 넘어간다", async () => {
  const calls: string[] = [];
  const primary: AnswerGenerator = {
    // eslint 없이도 의도가 보이게: 열려 있는 회로는 부르기도 전에 던진다.
    async *stream(): AsyncIterable<AnswerChunk> {
      throw new DependencyUnavailableError("local-generation");
    },
  };
  const chained = withFallback(primary, okGenerator("보루", calls));

  const texts = await collect(chained.stream("질문", [], new AbortController().signal));
  assert.deepEqual(texts, ["보루 답변"]);
});

test("2차에게도 이미지가 그대로 전달된다", async () => {
  const calls: string[] = [];
  const chained = withFallback(dyingGenerator(0, calls), okGenerator("보루", calls));

  await quietly(() =>
    collect(chained.stream("질문", [], new AbortController().signal, IMAGE))
  );
  assert.ok(calls.includes("보루+image"), "폴백하면서 이미지를 흘리면 답의 근거가 사라진다");
});

test("비전을 켜지 않은 로컬은 이미지 질문을 받지 않고, 체인이 보루로 보낸다", async () => {
  const calls: string[] = [];
  // OLLAMA_VISION 미설정(기본) 기준. 게이트는 회로보다 먼저라 네트워크도
  // 회로 기록도 없이 던진다 — 그래서 Ollama 없는 테스트 환경에서도 돈다.
  assert.throws(
    () => ollamaGenerator.stream("질문", [], new AbortController().signal, IMAGE),
    DependencyUnavailableError
  );

  const chained = withFallback(ollamaGenerator, okGenerator("보루", calls));
  const texts = await collect(
    chained.stream("질문", [], new AbortController().signal, IMAGE)
  );
  assert.deepEqual(texts, ["보루 답변"]);
});
