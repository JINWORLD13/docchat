// 생성기 폴백 체인 테스트.
//
// 폴백의 위험은 "넘어가면 안 되는 순간에 넘어가는 것"이다 — 이미 절반쯤
// 흘러간 답 뒤에 다른 모델이 처음부터 쓴 답이 이어붙거나, 떠난 사용자를 위해
// 보루까지 동원해 토큰을 만드는 것. 그 경계(첫 조각 전/후, abort)를 못박는다.

import test from "node:test";
import assert from "node:assert/strict";
import { breakered, ollamaGenerator, withFallback } from "./generator.ts";
import { createBreaker } from "../breaker.ts";
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

// --- 회로 판정: 판정되지 않고 끝난 요청 ---
//
// breakered의 규칙은 "스트림을 끝까지 소비했을 때만 성공, 떠난 사용자는 실패가
// 아님"이다. 그 규칙은 제너레이터가 yield 지점에서 닫히면 catch도 성공 처리도
// 타지 않는 것으로 자동으로 지켜진다 — 그런데 그때 반열림 시험권도 같이 사라졌다.
// 아래가 그 구멍을 막은 자리다.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 끝없이 조각을 내보내는 스트림. 소비하는 쪽이 중간에 끊는 상황을 만들기 위한 것이라,
// collect()로 넘기면 안 된다(끝까지 기다린다).
function endlessStream(): AsyncIterable<AnswerChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; ; i++) yield { text: `조각${i}` };
    },
  };
}

function finiteStream(): AsyncIterable<AnswerChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { text: "조각0" };
      yield { text: "조각1" };
    },
  };
}

test("중간에 끊긴 시험 요청이 회로를 영구히 열어두지 않는다", async () => {
  // 실제로 일어나는 경로다: 사용자가 탭을 닫거나(routes/chat.ts의 res.on("close")),
  // 카카오의 5초 예산이 끝나 스트림을 끊는다(routes/kakao.ts). 그 요청이 하필
  // 복구를 확인하는 시험 요청이면 시험권이 유실돼, 쿨다운이 끝나도 회로가
  // 영원히 열린 채 남았다. 게다가 state()는 쿨다운만 보므로 화면에는 "닫힘"이
  // 떠서, 모든 질문이 degrade로 떨어지는데 대시보드는 정상이라고 말했다.
  const circuit = createBreaker(2, 60);
  const live = new AbortController();

  const dying = breakered("test", circuit, () => {
    throw new Error("상류 죽음");
  });
  const endless = breakered("test", circuit, () => endlessStream());
  const healthy = breakered("test", circuit, () => finiteStream());

  // 1) 연속 실패로 회로를 연다
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => collect(dying.stream("질문", [], live.signal)));
  }
  assert.equal(circuit.state().open, true, "회로가 열렸다");

  // 2) 쿨다운이 끝난 뒤 시험 요청이 나가는데, 도중에 사용자가 떠난다
  await sleep(80);
  const gone = new AbortController();
  const got: string[] = [];
  for await (const chunk of endless.stream("질문", [], gone.signal)) {
    if (chunk.text) got.push(chunk.text);
    gone.abort(); // 탭을 닫았다
    break; // 코어의 `if (signal.aborted) break`와 같은 지점
  }
  assert.deepEqual(got, ["조각0"], "시험 요청 자체는 통과했다");

  // 3) 그 뒤의 멀쩡한 요청이 통과하고, 성공하면 회로가 완전히 닫힌다
  const texts = await collect(healthy.stream("질문", [], live.signal));
  assert.deepEqual(texts, ["조각0", "조각1"], "시험권이 유실되면 여기서 막힌다");
  assert.equal(circuit.state().consecutiveFailures, 0, "성공 판정으로 회로가 닫혔다");
  assert.equal(circuit.state().probing, false);
});

test("중단된 시험 요청을 실패로 세지 않는다", async () => {
  // 자리는 비우되 판정은 하지 않는다. 떠난 사용자를 실패로 세면 새로고침
  // 몇 번에 회로가 열려 멀쩡한 API를 차단한다.
  const circuit = createBreaker(2, 60);
  const gen = breakered("test", circuit, () => endlessStream());

  const gone = new AbortController();
  for await (const chunk of gen.stream("질문", [], gone.signal)) {
    assert.ok(chunk.text);
    gone.abort();
    break;
  }

  assert.equal(circuit.state().consecutiveFailures, 0, "중단은 장애가 아니다");
  assert.equal(circuit.state().probing, false, "그래도 시험권은 반납돼 있다");
});
