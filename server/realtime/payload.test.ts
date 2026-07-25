// 소켓 페이로드 방어 테스트.
//
// 이 테스트가 지키는 것은 편의가 아니라 가용성이다. 여기 케이스 중 하나라도
// 무너지면 핸들러에서 예외가 나고, Socket.IO는 그걸 잡아주지 않으므로
// 프로세스가 죽는다 — 잘못된 메시지 하나가 접속자 전원을 끊는다.

import test from "node:test";
import assert from "node:assert/strict";
import { readString } from "./payload.ts";

test("정상 페이로드에서 값을 꺼낸다", () => {
  assert.equal(readString({ text: "안녕" }, "text"), "안녕");
  assert.equal(readString({ nickname: "지영", room: "general" }, "room"), "general");
});

test("페이로드가 없거나 null이어도 터지지 않는다 (프로세스 사망 방지)", () => {
  // socket.emit("message") — 인자를 아예 안 주면 핸들러는 undefined를 받는다.
  assert.equal(readString(undefined, "text"), "");
  assert.equal(readString(null, "text"), "");
});

test("객체가 아닌 페이로드도 안전하게 넘긴다", () => {
  assert.equal(readString("문자열", "text"), "");
  assert.equal(readString(42, "text"), "");
  assert.equal(readString(true, "text"), "");
  assert.equal(readString([], "text"), "");
});

test("필드가 없으면 빈 문자열", () => {
  assert.equal(readString({}, "text"), "");
  assert.equal(readString({ other: "값" }, "text"), "");
});

test("문자열이 아닌 필드는 통과시키지 않는다", () => {
  // 이걸 그냥 넘기면 뒤에서 .trim()을 부르다 터진다.
  // 예전 코드가 (nickname ?? "")로 방어했지만 숫자는 ??를 그대로 통과했다.
  assert.equal(readString({ text: 1 }, "text"), "");
  assert.equal(readString({ text: null }, "text"), "");
  assert.equal(readString({ text: { nested: "값" } }, "text"), "");
  assert.equal(readString({ text: ["a"] }, "text"), "");
});

test("상속받은 값은 받은 필드로 치지 않는다", () => {
  // 우리가 실제로 받은 필드만 읽는다는 걸 고정한다.
  const payload = Object.create({ text: "주입" }) as unknown;
  assert.equal(readString(payload, "text"), "");
});
