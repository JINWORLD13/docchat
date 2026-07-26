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
  canJoin,
  sweepRooms,
  deleteRoom,
  removeMessage,
  imageInUse,
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

test("방 목록에 이름과 인원, 방장이 담긴다", () => {
  reset();
  addUser("general", "s1", "지영");
  addUser("general", "s2", "민수");

  assert.deepEqual(roomList(), [{ name: "general", users: 2, owner: "지영" }]);
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
  assert.deepEqual(roomList(), [{ name: "general", users: 0, owner: "지영" }]);
});

test("방이 하나도 없으면 빈 목록", () => {
  reset();
  assert.deepEqual(roomList(), []);
});

// --- 무한 증식 방지 ---
//
// 방은 이름만 대면 생긴다(join = 생성). 그래서 "기록이 있으면 유지한다"는
// 규칙만 두면, 새 방에 한 마디씩 하고 나가는 것을 반복해 방을 무한히 쌓을 수
// 있다. 비용은 메모리만이 아니다 — 방 목록은 구성이 바뀔 때마다 접속자
// 전원에게 통째로 나가므로, 방 수가 곧 브로드캐스트 크기다.

test("사람이 다 나간 방은 시간이 지나면 회수된다", () => {
  reset();
  const t0 = 1_000_000;
  addUser("한마디방", "s1", "지영");
  addMessage(msg("한마디방", "안녕"));
  removeUser("한마디방", "s1");

  assert.equal(roomStats().rooms, 1, "막 나간 직후에는 남아 있다");

  // 아직 유예 시간 안
  sweepRooms(60_000, t0);
  assert.equal(roomStats().rooms, 1, "잠깐 나갔다 오는 사람을 위해 붙잡아둔다");

  // 유예 시간을 넘기면 회수
  sweepRooms(60_000, Date.now() + 61_000);
  assert.equal(roomStats().rooms, 0, "빈 채로 오래 둔 방은 사라진다");
});

test("사람이 있는 방은 아무리 오래돼도 회수하지 않는다", () => {
  reset();
  addUser("사는방", "s1", "지영");
  addMessage(msg("사는방", "안녕"));

  sweepRooms(0, Date.now() + 10_000_000);

  assert.equal(roomStats().rooms, 1);
  assert.deepEqual(onlineUsers("사는방"), ["지영"]);
});

test("다시 사람이 들어오면 회수 대상에서 빠진다", () => {
  reset();
  addUser("돌아온방", "s1", "지영");
  addMessage(msg("돌아온방", "안녕"));
  removeUser("돌아온방", "s1");

  addUser("돌아온방", "s2", "민수"); // 재입장

  sweepRooms(0, Date.now() + 10_000_000);
  assert.equal(roomStats().rooms, 1, "비운 시각 표시가 지워져야 한다");
});

// --- 보낸 것 취소 ---

function image(room: string, id: string, nickname = "지영"): ChatMessage {
  return {
    id,
    room,
    nickname,
    kind: "image",
    url: `/api/chat/image/${id}`,
    width: 100,
    height: 100,
    ts: 0,
  };
}

test("보낸 사람은 자기 메시지를 취소할 수 있다", () => {
  reset();
  addUser("general", "s1", "지영");
  addMessage(msg("general", "안녕"));
  addMessage(msg("general", "실수", "지영"));

  const result = removeMessage("general", "general-실수", "지영");

  assert.equal(result.status, "ok");
  assert.deepEqual(
    history("general").map((m) => m.id),
    ["general-안녕"],
    "지운 것만 빠지고 나머지는 그대로"
  );
});

test("남이 보낸 메시지는 취소할 수 없다", () => {
  reset();
  addMessage(msg("general", "안녕", "지영"));

  assert.equal(removeMessage("general", "general-안녕", "민수").status, "denied");
  assert.equal(history("general").length, 1, "기록은 그대로 있다");
});

test("없는 메시지·없는 방을 취소하면 notfound", () => {
  reset();
  addMessage(msg("general", "안녕"));

  assert.equal(removeMessage("general", "없는id", "지영").status, "notfound");
  assert.equal(removeMessage("없는방", "general-안녕", "지영").status, "notfound");
});

test("취소한 메시지를 돌려준다 (이미지면 바이트까지 지워야 하므로)", () => {
  reset();
  addMessage(image("general", "11111111-1111-1111-1111-111111111111"));

  const result = removeMessage(
    "general",
    "11111111-1111-1111-1111-111111111111",
    "지영"
  );

  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.message.kind, "image");
});

test("같은 사진을 가리키는 메시지가 남아 있으면 아직 쓰는 중이다", () => {
  reset();
  const url = "/api/chat/image/11111111-1111-1111-1111-111111111111";
  addMessage(image("general", "11111111-1111-1111-1111-111111111111"));
  // 같은 이미지를 두 번 보낸 경우(직접 만든 클라이언트라면 가능하다)
  addMessage({ ...image("random", "11111111-1111-1111-1111-111111111111"), id: "두번째" });

  removeMessage("general", "11111111-1111-1111-1111-111111111111", "지영");

  assert.equal(imageInUse(url), true, "다른 방에 남아 있으면 바이트를 지우면 안 된다");

  removeMessage("random", "두번째", "지영");
  assert.equal(imageInUse(url), false, "마지막 참조까지 사라지면 지워도 된다");
});

// --- 방 삭제 (방장) ---
//
// 방장은 "처음 들어온 사람"으로 정해진다. 방 생성 절차가 따로 없어서
// (join = 생성) 그 순간 말고는 정할 시점이 없다.

test("방을 만든 사람은 방을 지울 수 있다", () => {
  reset();
  addUser("내방", "s1", "지영");
  addMessage(msg("내방", "안녕"));

  assert.equal(deleteRoom("내방", "지영"), "ok");

  assert.deepEqual(roomList(), [], "목록에서도 사라진다");
  assert.deepEqual(history("내방"), [], "대화 기록도 함께 사라진다");
});

test("나중에 들어온 사람은 남의 방을 지울 수 없다", () => {
  reset();
  addUser("내방", "s1", "지영");
  addUser("내방", "s2", "민수");

  assert.equal(deleteRoom("내방", "민수"), "denied");
  assert.equal(roomStats().rooms, 1, "방은 그대로 있다");
});

test("방장이 나갔다 와도 방장은 그대로다 (재연결로 권한이 날아가지 않는다)", () => {
  reset();
  addUser("내방", "s1", "지영");
  addMessage(msg("내방", "안녕"));
  removeUser("내방", "s1"); // 새로고침 = 다른 socket id로 재입장
  addUser("내방", "s2", "지영");

  assert.equal(deleteRoom("내방", "지영"), "ok");
});

test("방장이 방에 없어도 로비에서 지울 수 있다", () => {
  reset();
  addUser("내방", "s1", "지영");
  addMessage(msg("내방", "안녕"));
  removeUser("내방", "s1"); // 기록이 있으니 방은 남아 있다

  assert.equal(deleteRoom("내방", "지영"), "ok");
  assert.equal(roomStats().rooms, 0);
});

test("없는 방을 지우면 notfound", () => {
  reset();
  assert.equal(deleteRoom("없는방", "지영"), "notfound");
});

test("입장 없이 생긴 방은 아무도 지울 수 없다", () => {
  reset();
  // addMessage만으로 생긴 방(정상 경로에서는 나오지 않는다). owner가 비어 있어도
  // 빈 닉네임으로 권한이 통과되면 안 된다.
  addMessage(msg("떠돌이방", "안녕"));

  assert.equal(deleteRoom("떠돌이방", ""), "denied");
  assert.equal(deleteRoom("떠돌이방", "지영"), "denied");
});

test("지운 이름으로 다시 만들면 만든 사람이 새 방장이 된다", () => {
  reset();
  addUser("공용", "s1", "지영");
  deleteRoom("공용", "지영");

  addUser("공용", "s2", "민수");

  assert.deepEqual(roomList(), [{ name: "공용", users: 1, owner: "민수" }]);
});

test("이미 있는 방에는 상한과 무관하게 들어갈 수 있다", () => {
  reset();
  addUser("general", "s1", "지영");

  assert.equal(canJoin("general"), true);
  assert.equal(canJoin("새로운방"), true, "상한에 여유가 있으면 새 방도 만들 수 있다");
});
