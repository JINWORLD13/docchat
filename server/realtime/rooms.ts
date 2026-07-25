import type { ChatMessage, RoomSummary } from "./types.ts";

// 방 상태를 서버 메모리에 둔다 (MVP).
// 여기가 "빠른 임시 저장소"다. 서버가 죽으면 날아가므로, 다음 단계에서
// 영구 저장(Postgres)을 붙여 durability를 확보한다.
// 확장 단계에서 서버가 여러 대가 되면 이 상태를 Redis로 옮긴다 —
// 문서 Q&A 쪽 캐시(cache.ts)가 서버 한 대를 전제로 인메모리인 것과 같은 이유,
// 같은 한계다.

const MAX_HISTORY = 50; // 방마다 최근 50개만 메모리에 보관

interface RoomState {
  messages: ChatMessage[];
  users: Map<string, string>; // socketId -> nickname
}

const rooms = new Map<string, RoomState>();

function getRoom(room: string): RoomState {
  let state = rooms.get(room);
  if (!state) {
    state = { messages: [], users: new Map() };
    rooms.set(room, state);
  }
  return state;
}

export function addUser(room: string, socketId: string, nickname: string): void {
  getRoom(room).users.set(socketId, nickname);
}

export function removeUser(room: string, socketId: string): void {
  const state = rooms.get(room);
  if (!state) return;
  state.users.delete(socketId);
  // 아무도 없고 기록도 없으면 방을 정리한다 (메모리 누수 방지)
  if (state.users.size === 0 && state.messages.length === 0) rooms.delete(room);
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
