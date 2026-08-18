// RAG 코어 테스트.
//
// 이 파일이 존재할 수 있다는 것 자체가 코어를 분리한 이유다. 예전에는 이 로직이
// 라우트 안에 있어서 Postgres와 Gemini 없이는 한 줄도 부를 수 없었고, 그래서
// 서버에서 유일하게 테스트가 없는 부분이었다 — 하필 제일 중요한 부분이.
// 지금은 가짜 포트만 끼우면 거절·degrade·중단 같은 분기를 전부 검사할 수 있다.

import test from "node:test";
import assert from "node:assert/strict";
import { createRagEngine } from "./engine.ts";
import {
  DependencyUnavailableError,
  type AnswerChunk,
  type AnswerGenerator,
  type Embedder,
  type QueryLogRecord,
  type QuestionImage,
  type RagEvent,
  type RetrievedChunk,
  type Scope,
} from "./types.ts";

const UNRESTRICTED: Scope = { groups: null };

function chunk(similarity: number, content = "본문", filename = "문서.md"): RetrievedChunk {
  return { content, filename, similarity };
}

const okEmbedder: Embedder = { embedQuery: async () => [0.1, 0.2] };

// 검색 결과를 고정으로 돌려주면서, 코어가 넘긴 scope를 기록해둔다.
function fakeStore(rows: RetrievedChunk[]) {
  const seen: { scope: Scope | null; k: number } = { scope: null, k: 0 };
  return {
    seen,
    store: {
      async search(_v: number[], k: number, scope: Scope): Promise<RetrievedChunk[]> {
        seen.scope = scope;
        seen.k = k;
        return rows;
      },
    },
  };
}

function fakeGenerator(chunks: AnswerChunk[]): AnswerGenerator {
  return {
    async *stream(): AsyncIterable<AnswerChunk> {
      for (const c of chunks) yield c;
    },
  };
}

function throwingGenerator(error: Error): AnswerGenerator {
  return {
    // eslint 없이도 의도가 보이게: 아무것도 yield하지 않고 첫 next()에서 던진다.
    async *stream(): AsyncIterable<AnswerChunk> {
      throw error;
    },
  };
}

function fakeLogger() {
  const records: QueryLogRecord[] = [];
  return { records, logger: { log: (r: QueryLogRecord) => void records.push(r) } };
}

async function collect(events: AsyncIterable<RagEvent>): Promise<RagEvent[]> {
  const out: RagEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// degrade·오류 분기는 console.error를 부른다. 테스트 출력이 실패처럼 보이지
// 않게 잠깐 막아둔다.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test("관련 문서를 찾으면 출처 → 답변 → 완료 순으로 나온다", async () => {
  const { records, logger } = fakeLogger();
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.9, "환불은 7일 이내", "환불정책.md")]).store,
    generator: fakeGenerator([
      { text: "7일 이내에 가능합니다 [1]." },
      { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 12 } },
    ]),
    logger,
    now: () => 0,
  });

  const events = await collect(engine.ask("환불 되나요", UNRESTRICTED, new AbortController().signal));

  assert.deepEqual(
    events.map((e) => e.type),
    ["sources", "delta", "done"]
  );

  const [sources, , done] = events;
  assert.ok(sources?.type === "sources" && done?.type === "done");
  assert.deepEqual(sources.sources, [
    { index: 1, filename: "환불정책.md", snippet: "환불은 7일 이내", similarity: 0.9 },
  ]);
  assert.deepEqual(done.usage, { promptTokens: 900, outputTokens: 12 });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.refused, false);
  assert.equal(records[0]?.answer, "7일 이내에 가능합니다 [1].");
});

test("유사도가 임계값보다 낮으면 생성기를 부르지 않고 거절한다", async () => {
  const { records, logger } = fakeLogger();
  let generatorCalled = false;
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.5)]).store,
    generator: {
      async *stream(): AsyncIterable<AnswerChunk> {
        generatorCalled = true;
      },
    },
    logger,
    policy: { threshold: 0.62 },
    now: () => 0,
  });

  const events = await collect(engine.ask("점심 뭐 먹지", UNRESTRICTED, new AbortController().signal));

  assert.deepEqual(
    events.map((e) => e.type),
    ["refusal"]
  );
  assert.equal(generatorCalled, false, "거절했으면 외부 생성 API를 부르지 않아야 한다");
  assert.equal(records[0]?.refused, true);
  assert.equal(records[0]?.topSimilarity, 0.5);
});

test("검색 결과가 없어도 거절한다", async () => {
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([]).store,
    generator: fakeGenerator([{ text: "나오면 안 됨" }]),
    now: () => 0,
  });

  const events = await collect(engine.ask("아무거나", UNRESTRICTED, new AbortController().signal));
  assert.deepEqual(
    events.map((e) => e.type),
    ["refusal"]
  );
});

test("임베딩을 쓸 수 없으면 오류만 알리고 기록은 남기지 않는다", async () => {
  const { records, logger } = fakeLogger();
  const engine = createRagEngine({
    embedder: {
      embedQuery: async () => {
        throw new DependencyUnavailableError("embedding");
      },
    },
    store: fakeStore([chunk(0.9)]).store,
    generator: fakeGenerator([]),
    logger,
    now: () => 0,
  });

  const events = await collect(engine.ask("질문", UNRESTRICTED, new AbortController().signal));

  assert.deepEqual(
    events.map((e) => e.type),
    ["error"]
  );
  // 검색을 시작조차 못 했으므로 남길 유사도가 없다. 로그를 비워두는 게 맞다.
  assert.equal(records.length, 0);
});

test("생성기를 쓸 수 없으면 출처는 남기고 답변만 포기한다", async () => {
  const { records, logger } = fakeLogger();
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.9)]).store,
    generator: throwingGenerator(new DependencyUnavailableError("generation")),
    logger,
    now: () => 0,
  });

  const events = await quietly(() =>
    collect(engine.ask("질문", UNRESTRICTED, new AbortController().signal))
  );

  // 출처가 먼저 나갔기 때문에 사용자는 빈손이 아니다 — 이게 degradation의 요점이다.
  assert.deepEqual(
    events.map((e) => e.type),
    ["sources", "delta", "done"]
  );
  assert.equal(records[0]?.answer, "(degraded: breaker open)");
});

test("생성 중 오류가 나도 degrade하고, 원인을 구분해 기록한다", async () => {
  const { records, logger } = fakeLogger();
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.9)]).store,
    generator: throwingGenerator(new Error("상류 500")),
    logger,
    now: () => 0,
  });

  const events = await quietly(() =>
    collect(engine.ask("질문", UNRESTRICTED, new AbortController().signal))
  );

  assert.deepEqual(
    events.map((e) => e.type),
    ["sources", "delta", "done"]
  );
  assert.equal(records[0]?.answer, "(degraded: llm error)");
});

test("검색이 실패하면 오류 이벤트로 알린다", async () => {
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: {
      async search(): Promise<RetrievedChunk[]> {
        throw new Error("DB 연결 실패");
      },
    },
    generator: fakeGenerator([]),
    now: () => 0,
  });

  const events = await quietly(() =>
    collect(engine.ask("질문", UNRESTRICTED, new AbortController().signal))
  );

  assert.deepEqual(
    events.map((e) => e.type),
    ["error"]
  );
});

test("도중에 사용자가 떠나면 완료를 보내지 않고 중단으로 기록한다", async () => {
  const { records, logger } = fakeLogger();
  const controller = new AbortController();

  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.9)]).store,
    generator: {
      async *stream(): AsyncIterable<AnswerChunk> {
        yield { text: "앞부분" };
        controller.abort(); // 사용자가 탭을 닫은 시점
        yield { text: "이건 보내면 안 됨" };
      },
    },
    logger,
    now: () => 0,
  });

  const events = await collect(engine.ask("질문", UNRESTRICTED, controller.signal));

  assert.deepEqual(
    events.map((e) => e.type),
    ["sources", "delta"],
    "끊긴 응답에 done을 붙이면 관측이 거짓말을 하게 된다"
  );
  assert.equal(records[0]?.answer, "앞부분 (중단됨)");
});

test("열람 범위와 topK를 저장소에 그대로 넘긴다", async () => {
  const scoped: Scope = { groups: ["고객사-A"] };
  const { seen, store } = fakeStore([chunk(0.9)]);

  const engine = createRagEngine({
    embedder: okEmbedder,
    store,
    generator: fakeGenerator([{ text: "답" }]),
    policy: { topK: 3 },
    now: () => 0,
  });

  await collect(engine.ask("질문", scoped, new AbortController().signal));

  // 권한 필터가 코어를 그냥 통과해버리면 나중에 남의 문서가 새어나간다.
  assert.deepEqual(seen.scope, scoped);
  assert.equal(seen.k, 3);
});

test("빈 질문과 너무 긴 질문을 검증에서 걸러낸다", () => {
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([]).store,
    generator: fakeGenerator([]),
    policy: { maxQuestionLength: 10 },
  });

  assert.equal(engine.validate("").ok, false);
  assert.equal(engine.validate("짧은 질문").ok, true);

  const tooLong = engine.validate("가".repeat(11));
  assert.equal(tooLong.ok, false);
  assert.ok(!tooLong.ok && tooLong.message.includes("10자"));
});

// --- 이미지 첨부 질문 ---
//
// 이미지가 붙으면 거절 문턱이 적용되지 않는다(근거가 이미지 자체에 있으므로 —
// engine.ts [3]). 그 정책이 흐트러지는 방식은 두 가지다: 무관한 발췌를
// 근거랍시고 생성기에 끼워 보내거나, 발췌 없이 실패했으면서 "위 출처를 보라"고
// 말하거나. 셋 다 여기서 못박는다.

const IMAGE: QuestionImage = { mime: "image/png", data: new Uint8Array([1, 2, 3]) };

// 생성기가 받은 인자를 기록해두는 가짜. 코어가 발췌·이미지를 제대로
// 골라 넘기는지는 이벤트만 봐서는 알 수 없다.
function recordingGenerator(chunks: AnswerChunk[]) {
  const seen: { contexts: RetrievedChunk[] | null; image: QuestionImage | undefined } = {
    contexts: null,
    image: undefined,
  };
  const generator: AnswerGenerator = {
    async *stream(
      _question: string,
      contexts: RetrievedChunk[],
      _signal: AbortSignal,
      image?: QuestionImage
    ): AsyncIterable<AnswerChunk> {
      seen.contexts = contexts;
      seen.image = image;
      for (const c of chunks) yield c;
    },
  };
  return { seen, generator };
}

test("이미지가 있으면 유사도가 낮아도 거절하지 않되, 무관한 발췌는 주지 않는다", async () => {
  const { records, logger } = fakeLogger();
  const { seen, generator } = recordingGenerator([{ text: "이미지 속 오류는 설정 문제입니다." }]);
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.5)]).store, // 문턱(0.62) 미달
    generator,
    logger,
    now: () => 0,
  });

  const events = await collect(
    engine.ask("이 스크린샷의 오류 뭐야", UNRESTRICTED, new AbortController().signal, IMAGE)
  );

  // 출처가 없으므로 sources 이벤트도 없다. 거절 대신 답변이 나간다.
  assert.deepEqual(
    events.map((e) => e.type),
    ["delta", "done"]
  );
  // 문턱 미달 발췌를 끼워 보내면 생성기가 그걸 근거로 인용한다.
  assert.deepEqual(seen.contexts, []);
  assert.equal(seen.image, IMAGE);
  assert.equal(records[0]?.refused, false);
  assert.equal(records[0]?.topSimilarity, 0.5);
});

test("이미지가 있고 유사도도 높으면 발췌와 이미지를 함께 넘긴다", async () => {
  const { seen, generator } = recordingGenerator([{ text: "답 [1]." }]);
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.9, "환불은 7일 이내", "환불정책.md")]).store,
    generator,
    now: () => 0,
  });

  const events = await collect(
    engine.ask("이 영수증 환불 되나요", UNRESTRICTED, new AbortController().signal, IMAGE)
  );

  assert.deepEqual(
    events.map((e) => e.type),
    ["sources", "delta", "done"]
  );
  assert.equal(seen.contexts?.length, 1);
  assert.equal(seen.image, IMAGE);
});

test("발췌 없는 이미지 질문에서 생성이 실패하면 degrade가 아니라 오류다", async () => {
  const engine = createRagEngine({
    embedder: okEmbedder,
    store: fakeStore([chunk(0.5)]).store, // 문턱 미달 → 발췌 없이 이미지로만
    generator: throwingGenerator(new DependencyUnavailableError("generation")),
    now: () => 0,
  });

  const events = await quietly(() =>
    collect(engine.ask("이거 뭐야", UNRESTRICTED, new AbortController().signal, IMAGE))
  );

  // 보낸 출처가 없는데 "위 출처 문서를 확인해달라"는 degrade 문구가 나가면
  // 그 말은 거짓이 된다. 돌려줄 부분 결과가 없으니 오류가 맞다.
  assert.deepEqual(
    events.map((e) => e.type),
    ["error"]
  );
});
