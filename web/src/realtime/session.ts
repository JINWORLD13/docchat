// 닉네임과 마지막으로 있던 방을 탭에 저장해둔다.
//
// 없으면 탭을 옮길 때마다 처음으로 돌아간다. 실시간 채팅 화면(LiveChat)은
// 다른 탭을 누르면 언마운트되고, useState에 들고 있던 닉네임·방이 그때 전부
// 사라진다. 문서 Q&A를 잠깐 보고 돌아오면 닉네임 입력 화면부터 다시였다.
//
// localStorage가 아니라 sessionStorage인 이유는 저장 범위다. sessionStorage는
// 탭 하나에만 남아서, 탭 두 개를 열어 서로 대화해보는 데모(README)에서 양쪽이
// 각자 닉네임을 갖는다. localStorage에 두면 두 탭이 같은 닉네임을 공유해
// 대화 상대가 나 자신이 된다.
//
// 읽기·쓰기를 try/catch로 감싼 이유: 저장소 접근은 값이 없을 때가 아니라
// 접근 자체가 예외를 던질 수 있다(사파리 개인 브라우징, 쿠키·저장소 차단).
// 저장이 안 되는 건 "탭을 옮기면 다시 입력해야 한다" 정도의 불편이지만,
// 여기서 예외가 새어나가면 렌더 도중이라 화면 전체가 안 뜬다.

const NICK_KEY = "docchat.chat.nickname";
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

export function loadNickname(): string | null {
  return read(NICK_KEY);
}

export function loadRoom(): string | null {
  return read(ROOM_KEY);
}

export function saveNickname(nickname: string | null): void {
  write(NICK_KEY, nickname);
}

export function saveRoom(room: string | null): void {
  write(ROOM_KEY, room);
}
