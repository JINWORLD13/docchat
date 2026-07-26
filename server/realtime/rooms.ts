import type { ChatMessage, RoomSummary } from "./types.ts";

// 방 상태를 서버 메모리에 둔다 (MVP).
// 여기가 "빠른 임시 저장소"다. 서버가 죽으면 날아가므로, 다음 단계에서
// 영구 저장(Postgres)을 붙여 durability를 확보한다.
// 확장 단계에서 서버가 여러 대가 되면 이 상태를 Redis로 옮긴다 —
// 문서 Q&A 쪽 캐시(cache.ts)가 서버 한 대를 전제로 인메모리인 것과 같은 이유,
// 같은 한계다.

const MAX_HISTORY = 50; // 방마다 최근 50개만 메모리에 보관

// 서버가 동시에 들고 있을 방 수 상한.
// 방은 이름만 대면 생기므로(join = 생성), 상한이 없으면 아무나 이름을 바꿔가며
// 무한히 만들 수 있다. 그 비용은 메모리만이 아니다 — 방 목록은 구성이 바뀔
// 때마다 접속자 전원에게 통째로 나가므로, 방 수가 곧 브로드캐스트 크기다.
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);

// 사람이 다 나갔지만 기록이 남아 유지 중인 방을 언제까지 들고 있을지.
// 잠깐 나갔다 오는 사람에게 대화를 돌려주는 게 목적이므로, 그 시간이 지나면
// 붙잡고 있을 이유가 없다.
const EMPTY_ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);

interface RoomState {
  messages: ChatMessage[];
  users: Map<string, string>; // socketId -> nickname
  emptiedAt: number | null; // 마지막 사람이 나간 시각 (사람이 있으면 null)
  owner: string; // 방을 만든 사람의 닉네임 (= 처음 입장한 사람)
}

const rooms = new Map<string, RoomState>();

function getRoom(room: string, owner = ""): RoomState {
  let state = rooms.get(room);
  if (!state) {
    state = { messages: [], users: new Map(), emptiedAt: null, owner };
    rooms.set(room, state);
  }
  return state;
}

// 이 이름으로 입장할 수 있나. 이미 있는 방이면 언제나 가능하고,
// 새로 만드는 경우에만 상한에 걸린다.
export function canJoin(room: string): boolean {
  return rooms.has(room) || rooms.size < MAX_ROOMS;
}

// 방에 사람을 넣는다. 없는 방이면 여기서 생기고, 그 첫 사람이 방장이 된다
// (방 생성 절차가 따로 없으므로 join = 생성 = 방장 결정이다).
export function addUser(room: string, socketId: string, nickname: string): void {
  const state = getRoom(room, nickname);
  state.users.set(socketId, nickname);
  state.emptiedAt = null;
}

export function removeUser(room: string, socketId: string): void {
  const state = rooms.get(room);
  if (!state) return;
  state.users.delete(socketId);
  if (state.users.size > 0) return;

  // 아무도 없고 기록도 없으면 방을 즉시 정리한다 (메모리 누수 방지).
  if (state.messages.length === 0) {
    rooms.delete(room);
    return;
  }
  // 기록이 있으면 재입장을 위해 남겨두되, 언제부터 비었는지를 찍어둔다.
  // 이 표시가 없으면 "한 마디 하고 나간 방"이 영원히 쌓인다.
  state.emptiedAt = Date.now();
}

// 비운 지 오래된 방을 회수한다. 사람이 있는 방은 건드리지 않는다.
// now를 인자로 받는 이유는 tokenbucket과 같다 — 테스트에서 sleep 없이
// 시간을 주입해 결정적으로 검증할 수 있다.
export function sweepRooms(idleMs: number = EMPTY_ROOM_TTL_MS, now: number = Date.now()): number {
  let removed = 0;
  for (const [name, state] of rooms) {
    if (state.emptiedAt === null) continue;
    if (now - state.emptiedAt > idleMs) {
      rooms.delete(name);
      removed++;
    }
  }
  return removed;
}

// 방장이 방을 지운다.
//
// 권한 확인을 여기(상태를 아는 쪽)에 둔다. 게이트웨이가 "주인이 맞나"를 직접
// 판단하려면 방 상태를 꺼내가야 하고, 그러면 확인과 삭제 사이가 벌어진다.
//
// 방장은 닉네임으로 판별한다 — 이 앱에 로그인이 없어서 그게 가진 유일한 신원이다.
// 즉 같은 닉네임을 쓰는 사람은 남의 방을 지울 수 있다. 닉네임이 곧 신원인
// 다른 부분(발화자 표시·접속자 목록)과 같은 수준의 신뢰이고, 제대로 막으려면
// 계정이 필요하다. 소켓 id로 묶는 방법은 더 나쁘다 — 재연결마다 값이 바뀌어서
// 방장이 새로고침 한 번에 자기 방을 못 지우게 된다.
export function deleteRoom(room: string, nickname: string): "ok" | "notfound" | "denied" {
  const state = rooms.get(room);
  if (!state) return "notfound";
  // owner가 빈 문자열인 방(입장 없이 생긴 방)은 아무도 지울 수 없다.
  // 닉네임은 빈 값이 통과하지 못하므로(gateway의 hello) 여기서 우연히 맞을 일은 없다.
  if (!state.owner || state.owner !== nickname) return "denied";
  rooms.delete(room);
  return "ok";
}

export function onlineUsers(room: string): string[] {
  return [...(rooms.get(room)?.users.values() ?? [])];
}

export function addMessage(message: ChatMessage): void {
  const state = getRoom(message.room);
  state.messages.push(message);
  if (state.messages.length > MAX_HISTORY) state.messages.shift();
}

export function history(room: string): ChatMessage[] {
  return rooms.get(room)?.messages ?? [];
}

// 내가 보낸 것 취소.
//
// 방 삭제(deleteRoom)와 같은 이유로 권한 판단을 여기 둔다 — 확인과 삭제가
// 떨어져 있으면 그 사이에 대상이 바뀔 수 있다. 판별 기준도 같다: 닉네임.
// 메시지에 박혀 있는 nickname이 곧 작성자 표시이므로, 그것과 다른 기준을
// 쓰면 화면에 "내 말"로 보이는 것과 지울 수 있는 것이 어긋난다.
//
// 지운 메시지를 돌려주는 이유는 부르는 쪽이 뒷정리를 해야 하기 때문이다 —
// 이미지였다면 DB에 있는 바이트까지 지워야 한다(gateway.ts).
export function removeMessage(
  room: string,
  id: string,
  nickname: string
): { status: "ok"; message: ChatMessage } | { status: "notfound" } | { status: "denied" } {
  const state = rooms.get(room);
  if (!state) return { status: "notfound" };

  const message = state.messages.find((m) => m.id === id);
  if (!message) return { status: "notfound" };
  if (message.nickname !== nickname) return { status: "denied" };

  state.messages = state.messages.filter((m) => m !== message);
  return { status: "ok", message };
}

// 이 주소를 아직 쓰고 있는 메시지가 남아 있나.
//
// 보통 이미지 하나에 메시지 하나지만, 같은 imageId를 두 번 보내면(직접 만든
// 클라이언트라면 가능하다) 한 장을 두 메시지가 가리킨다. 그때 한쪽을 지우면서
// 바이트까지 없애면 남은 메시지가 깨진 사진이 된다. 방 전체를 훑지만 방당
// 최근 50개뿐이라 비용은 무시할 수준이다.
export function imageInUse(url: string): boolean {
  for (const state of rooms.values()) {
    for (const message of state.messages) {
      if (message.kind === "image" && message.url === url) return true;
    }
  }
  return false;
}

// 로비에 뿌릴 방 목록.
//
// 방은 누가 들어올 때 생기고(getRoom), 마지막 사람이 나가면서 기록도 없으면
// 사라진다. 그래서 이 목록은 "지금 살아 있는 방"만 보여준다.
// 빈 방을 계속 남겨두는 선택도 있지만, 그러면 한 번 만들어진 이름이 영원히
// 목록에 쌓인다. 청소해 줄 사람이 없는 MVP에서는 스스로 정리되는 쪽이 낫다고 봤다.
// (대화 기록이 남은 방은 사람이 없어도 유지되므로, 잠깐 나갔다 와도 방은 그대로다)
// owner를 같이 보내는 이유: 화면이 "이 방은 내가 지울 수 있다"를 판단해야 한다.
// 닉네임은 접속자 목록·말풍선으로 이미 공개되는 값이라 새로 드러나는 건 없다.
export function roomList(): RoomSummary[] {
  return [...rooms.entries()]
    .map(([name, state]) => ({ name, users: state.users.size, owner: state.owner }))
    .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));
}

// 대시보드용 집계.
export function roomStats(): { rooms: number; users: number } {
  let users = 0;
  for (const state of rooms.values()) users += state.users.size;
  return { rooms: rooms.size, users };
}

// 테스트 재실행용.
export function reset(): void {
  rooms.clear();
}
