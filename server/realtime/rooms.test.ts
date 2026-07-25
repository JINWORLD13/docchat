// 방 상태 단위 테스트.
//
// 소켓 핸들러(gateway.ts)는 Socket.IO 서버를 띄워야 검증되지만, 방 상태 관리는
// 순수 함수라 따로 뗄 수 있다. 실시간 기능에서 조용히 망가지기 쉬운 곳이
// 여기다 — 접속자 목록이 안 지워지거나(유령 사용자), 방이 안 치워져
// 메모리가 새는 것 둘 다 화면에는 한참 뒤에야 드러난다.

import test from "node:test";
import assert from "node:assert/strict";
import {
  addUser,
  removeUser,
  onlineUsers,
  addMessage,
  history,
  roomList,
  roomStats,
  reset,
} from "./rooms.ts";
import type { ChatMessage } from "./types.ts";

function msg(room: string, text: string, nickname = "지영"): ChatMessage {
  return { id: `${room}-${text}`, room, nickname, kind: "text", text, ts: 0 };
}

// ChatMessage는 텍스트/이미지 유니온이라 .text를 그냥 읽을 수 없다.
// 테스트에서도 종류를 확인하고 꺼낸다.
function textOf(message: ChatMessage | undefined): string | undefined {
  return message?.kind === "text" ? message.text : undefined;
}

test("입장한 사람이 접속자 목록에 잡힌다", () => {
  reset();
  addUser("general", "s1", "지영");
  addUser("general", "s2", "민수");

  assert.deepEqual(onlineUsers("general").sort(), ["민수", "지영"]);
});

test("방은 서로 격리된다", () => {
  reset();
  addUser("general", "s1", "지영");
  addUser("random", "s2", "민수");

  assert.deepEqual(onlineUsers("general"), ["지영"]);
  assert.deepEqual(onlineUsers("random"), ["민수"]);
});

test("나간 사람은 목록에서 빠진다 (유령 사용자 방지)", () => {
  reset();
  addUser("general", "s1", "지영");
  addUser("general", "s2", "민수");

  removeUser("general", "s1");

  assert.deepEqual(onlineUsers("general"), ["민수"]);
});

test("아무도 없고 기록도 없으면 방 자체를 치운다 (메모리 누수 방지)", () => {
  reset();
  addUser("잠깐방", "s1", "지영");
  assert.equal(roomStats().rooms, 1);

  removeUser("잠깐방", "s1");

  assert.equal(roomStats().rooms, 0, "빈 방은 남지 않는다");
});

test("기록이 남은 방은 사람이 없어도 유지된다 (재입장 시 히스토리)", () => {
  reset();
  addUser("general", "s1", "지영");
  addMessage(msg("general", "안녕"));

  removeUser("general", "s1");

  assert.equal(roomStats().rooms, 1);
  assert.equal(history("general").length, 1, "다시 들어오면 볼 기록이 남아 있다");
});

test("기록은 최근 50개까지만 보관한다", () => {
  reset();
  for (let i = 0; i < 60; i++) addMessage(msg("general", `m${i}`));

  const kept = history("general");
  assert.equal(kept.length, 50, "메모리가 무한정 늘지 않는다");
  assert.equal(textOf(kept[0]), "m10", "오래된 것부터 밀려난다");
  assert.equal(textOf(kept.at(-1)), "m59");
});

test("모르는 방을 물어보면 빈 값을 준다 (없는 방도 안전하게)", () => {
  reset();
  assert.deepEqual(onlineUsers("없는방"), []);
  assert.deepEqual(history("없는방"), []);
});

test("roomStats는 전체 방/접속자 수를 집계한다", () => {
  reset();
  addUser("a", "s1", "지영");
  addUser("a", "s2", "민수");
  addUser("b", "s3", "현우");

  assert.deepEqual(roomStats(), { rooms: 2, users: 3 });
});

// --- 로비 방 목록 ---

test("방 목록에 이름과 인원이 담긴다", () => {
  reset();
  addUser("general", "s1", "지영");
  addUser("general", "s2", "민수");

  assert.deepEqual(roomList(), [{ name: "general", users: 2 }]);
});

test("사람이 많은 방이 위로, 같으면 이름순으로 정렬한다", () => {
  reset();
  addUser("나중", "s1", "지영");
  addUser("붐비는방", "s2", "민수");
  addUser("붐비는방", "s3", "현우");
  addUser("가나다", "s4", "수진");

  assert.deepEqual(
    roomList().map((r) => r.name),
    ["붐비는방", "가나다", "나중"],
    "인원 내림차순 → 이름 오름차순"
  );
});

test("아무도 없고 기록도 없는 방은 목록에서 사라진다", () => {
  reset();
  addUser("잠깐방", "s1", "지영");
  assert.equal(roomList().length, 1);

  removeUser("잠깐방", "s1");

  assert.deepEqual(roomList(), [], "빈 방이 목록에 쌓이지 않는다");
});

test("대화가 오간 방은 사람이 없어도 목록에 0명으로 남는다", () => {
  reset();
  addUser("general", "s1", "지영");
  addMessage(msg("general", "안녕"));

  removeUser("general", "s1");

  // 기록이 있으니 방은 살아 있다 — 다시 들어오면 대화를 이어볼 수 있다.
  assert.deepEqual(roomList(), [{ name: "general", users: 0 }]);
});

test("방이 하나도 없으면 빈 목록", () => {
  reset();
  assert.deepEqual(roomList(), []);
});
