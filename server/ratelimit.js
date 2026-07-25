// 사용자(IP)별 요청 제한 — Token Bucket 알고리즘 (직접 구현).
//
// 문제: 악의적 사용자 한 명, 혹은 버그로 폭주하는 클라이언트 하나가
// 초당 수백 건을 쏘면 서버 전체가 마비된다. 한 명의 실수가 전체 장애로
// 번지는 걸 가장 앞단에서 막는 장치다(예방).
//
// 왜 Token Bucket인가 (대안 비교):
// - 고정 윈도우 카운터: 윈도우 경계에서 순간적으로 한도의 2배가 몰리는 허점.
// - 순간 거절만: 사람은 원래 몰아서 보내는데(연타), 정상 버스트까지 막혀 불편.
// - Token Bucket: 버킷 용량(capacity)만큼 순간 버스트는 허용하되,
//   토큰이 초당 refill 속도로만 차므로 "평균 속도"는 확실히 제한된다.
//   버스트 허용 + 평균 제한을 동시에 만족하는 표준 선택.

const CAPACITY = Number(process.env.RL_CAPACITY || 10); // 버킷 용량 = 순간 허용 버스트
const REFILL_PER_SEC = Number(process.env.RL_REFILL || 5); // 초당 채워지는 토큰 = 평균 허용 속도

const buckets = new Map(); // ip -> { tokens, last }
let rejected = 0; // 관측용: 지금까지 거절한 요청 수

export function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: CAPACITY, last: now };
    buckets.set(ip, b);
  }

  // 지난 시간만큼 토큰을 채운다 (최대 CAPACITY까지)
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.last = now;

  if (b.tokens < 1) {
    rejected++;
    const waitSec = Math.ceil((1 - b.tokens) / REFILL_PER_SEC);
    res.setHeader("Retry-After", String(waitSec)); // 언제 다시 오면 되는지 알려준다
    return res.status(429).json({ error: "요청이 너무 잦아요. 잠시 후 다시 시도해주세요." });
  }

  b.tokens -= 1; // 토큰 하나 소비하고 통과
  next();
}

export function rateLimitStats() {
  return { buckets: buckets.size, rejected, capacity: CAPACITY, refillPerSec: REFILL_PER_SEC };
}

// 오래 안 쓴 버킷을 주기적으로 청소해 메모리 누수를 막는다.
// unref()로 이 타이머가 프로세스 종료를 붙잡지 않게 한다.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now - b.last > 10 * 60 * 1000) buckets.delete(ip); // 10분 유휴면 제거
  }
}, 60 * 1000);
sweep.unref?.();
