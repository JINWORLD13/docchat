// 소켓 트래픽 제한.
//
// 한 명이 도배로 방 전체를 마비시키는 걸 막는다. 문서 Q&A 쪽 HTTP 제한
// (../ratelimit.ts)과 완전히 같은 알고리즘을 쓰되, 값만 다르다.
// 실제 구현은 ../tokenbucket.ts 한 곳에 있다.
//
// 값이 다른 이유: HTTP 질문은 한 건이 비싸고(임베딩+LLM) 드물게 오지만,
// 채팅 메시지는 싸고 자주 온다. 대신 채팅은 한 명의 도배가 방 전체 사람들
// 화면을 덮어버리므로, 순간 버스트를 더 좁게 잡았다.
//
// 버킷을 소켓 id가 아니라 IP로 나누는 이유:
// 예전엔 키가 socket.id였다. 그런데 socket.id는 연결할 때마다 새로 생기므로
// "5발 쏘고 → 끊고 → 다시 붙으면" 매번 새 버킷을 만땅으로 받았다. 제한이
// 사실상 재연결 속도에만 걸리는 셈이라 도배를 전혀 못 막는다.
// 그래서 재연결해도 따라오는 값(IP)을 키로 쓴다.
//
// 그런데 키만 바꿔서는 반만 고친 것이었다.
// 소켓에는 disconnect라는 명확한 종료 신호가 있으니 마지막 소켓이 끊길 때
// 버킷을 즉시 지우는 게 깔끔하다고 봤는데, 그게 바로 위의 우회를 되살렸다 —
// 혼자 접속한 사람은 끊는 순간 자기 버킷이 사라지고, 다시 붙으면 만땅이다.
// 실제로 재보니 유지 연결로 9발 나갈 시간에 끊었다 붙으면 20발이 나갔다.
//
// 여기서 배운 것: 제한의 수명은 연결의 수명보다 길어야 한다. 연결이 끝난 걸
// 안다고 해서 "이 사람이 쓴 예산"까지 잊어도 되는 건 아니다. 종료 신호는
// 회수 시점을 정하는 근거로는 맞지만, 제한을 지우는 근거로는 틀렸다.
// 그래서 회수는 HTTP 쪽과 똑같이 유휴 스윕으로 한다. 살아 있는 소켓 수는
// 여전히 세지만, 그건 IP당 동시 연결 상한에만 쓴다.

import { TokenBuckets, type TokenBucketStats } from "../tokenbucket.ts";

const CAPACITY = Number(process.env.CHAT_RL_CAPACITY || 5); // 순간 최대 5개
const REFILL_PER_SEC = Number(process.env.CHAT_RL_REFILL || 2); // 초당 2개 충전

// 메시지가 아닌 이벤트(방 이동·입력중 표시)용 별도 버킷.
// 메시지보다 싸지만 공짜는 아니다 — join 한 번은 방 목록 전체를 접속자
// 전원에게 밀어내는 1:N 증폭이고, typing은 방 사람들에게 매번 뿌려진다.
// 정상 사용을 방해하지 않을 만큼 넉넉히 두되 상한은 반드시 둔다.
const ACTION_CAPACITY = Number(process.env.CHAT_ACTION_CAPACITY || 20);
const ACTION_REFILL = Number(process.env.CHAT_ACTION_REFILL || 10);

// IP 하나가 열 수 있는 동시 소켓 수.
// 이게 없으면 위의 IP별 제한을 "연결을 여러 개 여는" 방식으로 곱해버릴 수 있다.
const MAX_SOCKETS_PER_IP = Number(process.env.CHAT_MAX_SOCKETS_PER_IP || 10);

// 핸드셰이크(연결 시도)용 버킷. 위의 동시 연결 상한과 다른 것을 막는다 —
// 상한은 "성공한 연결"만 세는데, 인증에 실패하는 시도는 성공하지 못하므로
// 어떤 한도에도 안 세어진다. 그런데 그 시도 하나하나가 세션 조회(DB일 수
// 있는)를 태우므로, 시도 자체에 상한이 없으면 지어낸 쿠키의 반복 연결이
// readPool을 공짜로 두드린다(gateway.ts의 io.use). 정상 재연결은 backoff를
// 타고 드물게 오므로 초당 1 회복이면 안 걸린다.
const HANDSHAKE_CAPACITY = Number(process.env.CHAT_HANDSHAKE_CAPACITY || 10);
const HANDSHAKE_REFILL = Number(process.env.CHAT_HANDSHAKE_REFILL || 1);

const messageBuckets = new TokenBuckets(CAPACITY, REFILL_PER_SEC);
const actionBuckets = new TokenBuckets(ACTION_CAPACITY, ACTION_REFILL);
const handshakeBuckets = new TokenBuckets(HANDSHAKE_CAPACITY, HANDSHAKE_REFILL);

// 유휴 버킷 회수. 끊겼다고 지우지 않고, 한동안 아무 활동이 없을 때만 지운다
// (위 헤더 주석 참고 — 지우는 시점이 곧 우회 지점이었다).
// 충전 속도가 초당 2개라 10분이면 어차피 만땅이므로, 그때 지우는 것은
// "예산을 잊는" 것이 아니라 "이미 다 회복된 빈 항목을 치우는" 것이다.
const IDLE_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  messageBuckets.sweep(IDLE_MS);
  actionBuckets.sweep(IDLE_MS);
  handshakeBuckets.sweep(IDLE_MS);
}, 60 * 1000);
sweeper.unref();

// IP -> 지금 붙어 있는 소켓 수. IP당 동시 연결 상한에만 쓴다.
const liveSockets = new Map<string, number>();

// 연결을 등록한다. 상한을 넘으면 false — 부르는 쪽에서 연결을 끊는다.
export function addSocket(ip: string): boolean {
  const n = liveSockets.get(ip) ?? 0;
  if (n >= MAX_SOCKETS_PER_IP) return false;
  liveSockets.set(ip, n + 1);
  return true;
}

// 연결이 끊겼다. 연결 수만 줄인다.
//
// 버킷은 일부러 남긴다. 여기서 지우면 "끊었다 다시 붙기"로 제한이 초기화된다 —
// 정확히 socket.id를 키로 썼을 때의 우회가 되돌아온다. 회수는 위의 스윕이 한다.
export function removeSocket(ip: string): void {
  const n = (liveSockets.get(ip) ?? 1) - 1;
  if (n > 0) {
    liveSockets.set(ip, n);
    return;
  }
  liveSockets.delete(ip);
}

export function allowMessage(ip: string): boolean {
  return messageBuckets.take(ip).ok;
}

export function allowAction(ip: string): boolean {
  return actionBuckets.take(ip).ok;
}

// 인증(세션 조회)보다 먼저 불린다 — 위 handshakeBuckets 주석 참고.
export function allowHandshake(ip: string): boolean {
  return handshakeBuckets.take(ip).ok;
}

export function chatRateLimitStats(): TokenBucketStats {
  return messageBuckets.stats();
}

// 테스트 재실행용.
export function reset(): void {
  messageBuckets.reset();
  actionBuckets.reset();
  handshakeBuckets.reset();
  liveSockets.clear();
}
