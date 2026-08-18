// 카카오 어댑터 테스트 — express 없이 순수 부분만.
//
// 여기서 지키려는 것: 5초 예산의 경계 동작이다. 예산 안에 끝난 답이 "부분"으로
// 나가거나, 예산을 넘긴 수집이 스냅샷에 뒷조각을 섞으면, 사용자는 멀쩡한 답을
// 잘린 채 받거나 잘린 답을 완답인 줄 알고 받는다.

import test from "node:test";
import assert from "node:assert/strict";
import {
  callbackWaitResponse,
  collectWithBudget,
  parseSkillPayload,
  simpleTextResponse,
  skillText,
  type CollectedAnswer,
} from "./kakao.ts";
import type { ChatEvent, SourceRef } from "./types.ts";

const SOURCE: SourceRef = { index: 1, filename: "환불정책.md", snippet: "환불은", similarity: 0.74 };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function* fastStream(): AsyncIterable<ChatEvent> {
  yield { type: "sources", sources: [SOURCE] };
  yield { type: "delta", text: "7일 이내" };
  yield { type: "delta", text: "에 가능합니다 [1]." };
  yield { type: "done", usage: { promptTokens: 1, outputTokens: 2 } };
}

// --- 페이로드 해석 ---

test("오픈빌더 페이로드에서 발화·사용자·콜백을 꺼낸다", () => {
  const parsed = parseSkillPayload({
    userRequest: {
      utterance: "  환불 되나요  ",
      user: { id: "kakao-user-1" },
      callbackUrl: "https://bot-api.kakao.com/callback/abc",
    },
  });
  assert.deepEqual(parsed, {
    utterance: "환불 되나요",
    userId: "kakao-user-1",
    callbackUrl: "https://bot-api.kakao.com/callback/abc",
  });
});

test("발화가 없거나 모양이 다르면 null", () => {
  assert.equal(parseSkillPayload(null), null);
  assert.equal(parseSkillPayload({ userRequest: { utterance: "   " } }), null);
  assert.equal(parseSkillPayload({ utterance: "userRequest 밖에 있음" }), null);
});

test("https가 아닌 콜백 주소는 버린다", () => {
  // 이 값은 요청 본문에서 오므로, 아무 주소나 받으면 답변을 임의 서버로
  // 배달하는 통로가 된다.
  const parsed = parseSkillPayload({
    userRequest: { utterance: "질문", callbackUrl: "http://evil.example/steal" },
  });
  assert.equal(parsed?.callbackUrl, null);
});

// --- 예산 수집 ---

test("예산 안에 끝나면 완성으로 표시되고 전부 모인다", async () => {
  const { first, full } = collectWithBudget(fastStream(), 1000);
  const head = await first;

  assert.equal(head.finished, true);
  assert.equal(head.snapshot.text, "7일 이내에 가능합니다 [1].");
  assert.deepEqual(head.snapshot.sources, [SOURCE]);
  assert.equal((await full).kind, "answer");
});

test("예산을 넘기면 그 순간까지의 부분만 스냅샷으로 준다", async () => {
  async function* slowStream(): AsyncIterable<ChatEvent> {
    yield { type: "delta", text: "앞부분" };
    await sleep(80); // 예산(20ms)보다 오래 걸리는 생성
    yield { type: "delta", text: " 뒷부분" };
  }
  const { first, full } = collectWithBudget(slowStream(), 20);

  const head = await first;
  assert.equal(head.finished, false);
  assert.equal(head.snapshot.text, "앞부분", "예산 시점 이후의 조각이 스냅샷에 섞이면 안 된다");

  // 콜백 경로가 기다리는 full은 그대로 끝까지 모은다.
  assert.equal((await full).text, "앞부분 뒷부분");
});

test("거절 이벤트는 거절로 모인다", async () => {
  async function* refusalStream(): AsyncIterable<ChatEvent> {
    yield { type: "refusal", message: "관련 내용을 찾지 못했어요." };
  }
  const head = await collectWithBudget(refusalStream(), 1000).first;
  assert.equal(head.snapshot.kind, "refusal");
  assert.equal(head.snapshot.text, "관련 내용을 찾지 못했어요.");
});

// --- 응답 문구 조립 ---

function answer(text: string, sources: SourceRef[] = []): CollectedAnswer {
  return { kind: "answer", text, sources };
}

test("완답에는 출처가 붙는다", () => {
  const text = skillText(answer("7일 이내입니다 [1].", [SOURCE]), true);
  assert.ok(text.startsWith("7일 이내입니다 [1]."));
  assert.ok(text.includes("참고한 문서"));
  assert.ok(text.includes("환불정책.md (유사도 0.74)"));
});

test("긴 답은 출처를 지키고 본문을 자른다", () => {
  const text = skillText(answer("가".repeat(2000), [SOURCE]), true);
  assert.ok(text.length <= 1000, "simpleText 제한(1000자)을 넘기면 응답 전체가 버려진다");
  assert.ok(text.includes("환불정책.md"), "잘리더라도 출처는 남아야 한다");
});

test("부분 답변에는 잘렸다는 안내가 붙고, 빈 부분은 안내 문구로 대체된다", () => {
  const partial = skillText(answer("여기까지 만든 답"), false);
  assert.ok(partial.includes("여기까지 만든 답"));
  assert.ok(partial.includes("시간 제한"));

  const empty = skillText(answer(""), false);
  assert.ok(empty.includes("잠시 후 다시"));
});

test("거절·오류 문구는 코어가 만든 그대로 나간다", () => {
  assert.equal(skillText({ kind: "refusal", text: "못 찾았어요.", sources: [] }, true), "못 찾았어요.");
  assert.equal(skillText({ kind: "error", text: "오류예요.", sources: [] }, false), "오류예요.");
});

// --- 스킬 응답 모양 ---

test("응답 JSON이 오픈빌더 형식을 지킨다", () => {
  assert.deepEqual(simpleTextResponse("안녕"), {
    version: "2.0",
    template: { outputs: [{ simpleText: { text: "안녕" } }] },
  });
  assert.deepEqual(callbackWaitResponse("잠깐만요"), {
    version: "2.0",
    useCallback: true,
    data: { text: "잠깐만요" },
  });
});
