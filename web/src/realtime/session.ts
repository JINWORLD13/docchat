// 마지막으로 있던 방을 탭에 저장해둔다.
//
// 없으면 탭을 옮길 때마다 로비로 돌아간다. 실시간 채팅 화면(LiveChat)은
// 다른 탭을 누르면 언마운트되고, useState에 들고 있던 방이 그때 사라진다.
//
// 닉네임과 clientKey도 여기 있었는데 로그인(AuthGate)이 생기면서 사라졌다 —
// 이름은 계정에 있고, 신원은 세션 쿠키가 증명한다(server/auth.ts).
//
// localStorage가 아니라 sessionStorage인 이유는 저장 범위다. 방 선택은 "이 탭이
// 보던 화면"의 일부라 탭마다 달라야 자연스럽다.
//
// 읽기·쓰기를 try/catch로 감싼 이유: 저장소 접근은 값이 없을 때가 아니라
// 접근 자체가 예외를 던질 수 있다(사파리 개인 브라우징, 쿠키·저장소 차단).
// 저장이 안 되는 건 "탭을 옮기면 로비부터 다시" 정도의 불편이지만,
// 여기서 예외가 새어나가면 렌더 도중이라 화면 전체가 안 뜬다.

const ROOM_KEY = "docchat.chat.room";

function read(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // 저장 못 해도 이번 화면은 그대로 쓴다
  }
}

export function loadRoom(): string | null {
  return read(ROOM_KEY);
}

export function saveRoom(room: string | null): void {
  write(ROOM_KEY, room);
}
