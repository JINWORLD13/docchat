// 소켓(사용자)별 메시지 전송 제한.
//
// 한 명이 도배로 방 전체를 마비시키는 걸 막는다. 문서 Q&A 쪽 HTTP 제한
// (../ratelimit.ts)과 완전히 같은 알고리즘을 쓰되, 값만 다르다.
// 실제 구현은 ../tokenbucket.ts 한 곳에 있다.
//
// 값이 다른 이유: HTTP 질문은 한 건이 비싸고(임베딩+LLM) 드물게 오지만,
// 채팅 메시지는 싸고 자주 온다. 대신 채팅은 한 명의 도배가 방 전체 사람들
// 화면을 덮어버리므로, 순간 버스트를 더 좁게 잡았다.

import { TokenBuckets, type TokenBucketStats } from "../tokenbucket.ts";

const CAPACITY = Number(process.env.CHAT_RL_CAPACITY || 5); // 순간 최대 5개
const REFILL_PER_SEC = Number(process.env.CHAT_RL_REFILL || 2); // 초당 2개 충전

const buckets = new TokenBuckets(CAPACITY, REFILL_PER_SEC);

export function allowMessage(socketId: string): boolean {
  return buckets.take(socketId).ok;
}

// 연결이 끊기면 즉시 정리한다.
// IP 기반 제한과 달리 소켓은 "끝났다"는 신호(disconnect)가 명확해서,
// 유휴 스윕 타이머 없이 정확한 시점에 회수할 수 있다.
export function dropBucket(socketId: string): void {
  buckets.drop(socketId);
}

export function chatRateLimitStats(): TokenBucketStats {
  return buckets.stats();
}
