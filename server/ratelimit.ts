// 사용자(IP)별 HTTP 요청 제한.
//
// 문제: 악의적 사용자 한 명, 혹은 버그로 폭주하는 클라이언트 하나가
// 초당 수백 건을 쏘면 서버 전체가 마비된다. 한 명의 실수가 전체 장애로
// 번지는 걸 가장 앞단에서 막는 장치다(예방).
//
// 알고리즘 자체(Token Bucket)와 그걸 고른 이유는 tokenbucket.ts에 있다.
// 여기는 "그 알고리즘을 HTTP 요청에 어떻게 붙이느냐"만 다룬다.

import type { RequestHandler } from "express";
import { TokenBuckets, type TokenBucketStats } from "./tokenbucket.ts";

const CAPACITY = Number(process.env.RL_CAPACITY || 10); // 순간 허용 버스트
const REFILL_PER_SEC = Number(process.env.RL_REFILL || 5); // 평균 허용 속도

const IDLE_MS = 10 * 60 * 1000; // 10분 안 쓴 IP 버킷은 회수
const SWEEP_INTERVAL_MS = 60 * 1000;

const buckets = new TokenBuckets(CAPACITY, REFILL_PER_SEC);

export const rateLimit: RequestHandler = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const result = buckets.take(ip);

  if (!result.ok) {
    // 언제 다시 오면 되는지 알려준다 (클라이언트가 재시도 간격을 조절할 수 있게)
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: "요청이 너무 잦아요. 잠시 후 다시 시도해주세요." });
    return;
  }

  next();
};

export function rateLimitStats(): TokenBucketStats {
  return buckets.stats();
}

// 테스트 재실행용.
export function resetRateLimit(): void {
  buckets.reset();
}

// 오래 안 쓴 버킷을 주기적으로 청소한다.
// unref()로 이 타이머가 프로세스 종료를 붙잡지 않게 한다.
const sweeper = setInterval(() => buckets.sweep(IDLE_MS), SWEEP_INTERVAL_MS);
sweeper.unref();
