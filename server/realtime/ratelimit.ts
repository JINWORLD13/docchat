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
// 예전엔 키가 socket.id였다. 그런데 socket.id는 연결할 때마다 새로 생기고
// disconnect 때 버킷을 지우므로, "5발 쏘고 → 끊고 → 다시 붙으면" 매번 새
// 버킷을 만땅으로 받았다. 제한이 사실상 재연결 속도에만 걸리는 셈이라
// 도배를 전혀 못 막는다. 그래서 재연결해도 따라오는 값(IP)을 키로 쓴다.
//
// 대신 회수는 여전히 정확한 시점에 한다. IP당 살아 있는 소켓 수를 세고,
// 마지막 하나가 끊길 때 그 IP의 버킷을 즉시 지운다 — HTTP 쪽처럼 유휴 스윕에
// 기대지 않아도 되는 건, 소켓에는 disconnect라는 명확한 종료 신호가 있어서다.

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

const messageBuckets = new TokenBuckets(CAPACITY, REFILL_PER_SEC);
const actionBuckets = new TokenBuckets(ACTION_CAPACITY, ACTION_REFILL);

// IP -> 지금 붙어 있는 소켓 수. 0이 되는 순간 그 IP의 버킷을 회수한다.
const liveSockets = new Map<string, number>();

// 연결을 등록한다. 상한을 넘으면 false — 부르는 쪽에서 연결을 끊는다.
export function addSocket(ip: string): boolean {
  const n = liveSockets.get(ip) ?? 0;
  if (n >= MAX_SOCKETS_PER_IP) return false;
  liveSockets.set(ip, n + 1);
  return true;
}

// 연결이 끊겼다. 그 IP의 마지막 소켓이었으면 버킷까지 정리한다.
export function removeSocket(ip: string): void {
  const n = (liveSockets.get(ip) ?? 1) - 1;
  if (n > 0) {
    liveSockets.set(ip, n);
    return;
  }
  liveSockets.delete(ip);
  messageBuckets.drop(ip);
  actionBuckets.drop(ip);
}

export function allowMessage(ip: string): boolean {
  return messageBuckets.take(ip).ok;
}

export function allowAction(ip: string): boolean {
  return actionBuckets.take(ip).ok;
}

export function chatRateLimitStats(): TokenBucketStats {
  return messageBuckets.stats();
}

// 테스트 재실행용.
export function reset(): void {
  messageBuckets.reset();
  actionBuckets.reset();
  liveSockets.clear();
}
