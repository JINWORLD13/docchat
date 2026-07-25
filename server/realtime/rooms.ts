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
}

const rooms = new Map<string, RoomState>();

function getRoom(room: string): RoomState {
  let state = rooms.get(room);
  if (!state) {
    state = { messages: [], users: new Map(), emptiedAt: null };
    rooms.set(room, state);
  }
  return state;
}

// 이 이름으로 입장할 수 있나. 이미 있는 방이면 언제나 가능하고,
// 새로 만드는 경우에만 상한에 걸린다.
export function canJoin(room: string): boolean {
  return rooms.has(room) || rooms.size < MAX_ROOMS;
}

export function addUser(room: string, socketId: string, nickname: string): void {
  const state = getRoom(room);
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

// 로비에 뿌릴 방 목록.
//
// 방은 누가 들어올 때 생기고(getRoom), 마지막 사람이 나가면서 기록도 없으면
// 사라진다. 그래서 이 목록은 "지금 살아 있는 방"만 보여준다.
// 빈 방을 계속 남겨두는 선택도 있지만, 그러면 한 번 만들어진 이름이 영원히
// 목록에 쌓인다. 청소해 줄 사람이 없는 MVP에서는 스스로 정리되는 쪽이 낫다고 봤다.
// (대화 기록이 남은 방은 사람이 없어도 유지되므로, 잠깐 나갔다 와도 방은 그대로다)
export function roomList(): RoomSummary[] {
  return [...rooms.entries()]
    .map(([name, state]) => ({ name, users: state.users.size }))
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
