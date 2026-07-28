// Token Bucket — 키(IP, 소켓 id 등)별 속도 제한의 공용 구현.
//
// 왜 Token Bucket인가 (대안 비교):
// - 고정 윈도우 카운터: 윈도우 경계에서 순간적으로 한도의 2배가 몰리는 허점.
// - 순간 거절만: 사람은 원래 몰아서 보내는데(연타), 정상 버스트까지 막혀 불편.
// - Token Bucket: 버킷 용량(capacity)만큼 순간 버스트는 허용하되,
//   토큰이 초당 refill 속도로만 차므로 "평균 속도"는 확실히 제한된다.
//   버스트 허용 + 평균 제한을 동시에 만족하는 표준 선택.
//
// 이 파일이 따로 있는 이유:
// 원래 HTTP 요청 제한(ratelimit.ts)과 실시간 채팅의 메시지 제한(realtime/ratelimit.ts)에
// 같은 알고리즘이 각각 복사돼 있었다. 두 기능을 한 서버로 합치면서 중복이 드러나
// 여기로 뽑아냈다. 알고리즘을 고칠 일이 생기면 이제 한 곳만 고치면 된다.
// 제한 값(capacity/refill)은 용도마다 다르므로 인스턴스별로 받는다.

interface Bucket {
  tokens: number;
  last: number; // 마지막으로 토큰을 계산한 시각 (epoch ms)
}

// 통과/거절을 boolean 하나로 돌려주면 "얼마나 기다려야 하는지"를 부르는 쪽에서
// 다시 계산해야 한다. 거절일 때만 대기 시간이 존재한다는 사실을 타입으로 못박아,
// 통과한 경우에 retryAfterSec을 읽는 실수를 컴파일러가 막게 한다.
export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface TokenBucketStats {
  buckets: number; // 지금 추적 중인 키 수
  rejected: number; // 누적 거절 수 (관측용)
  capacity: number;
  refillPerSec: number;
}

export class TokenBuckets {
  #capacity: number;
  #refillPerSec: number;
  #buckets = new Map<string, Bucket>();
  #rejected = 0;

  constructor(capacity: number, refillPerSec: number) {
    this.#capacity = capacity;
    this.#refillPerSec = refillPerSec;
  }

  // 토큰 하나를 쓴다. 없으면 거절하고 언제 다시 오면 되는지 알려준다.
  take(key: string, now: number = Date.now()): TakeResult {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.#capacity, last: now };
      this.#buckets.set(key, bucket);
    }

    // 지난 시간만큼 토큰을 채운다 (최대 capacity까지)
    // 음수를 막는 이유: 시계는 뒤로 갈 수 있다(NTP 보정). 그대로 두면 경과
    // 시간이 음수가 되어 토큰을 오히려 깎고, retryAfter도 부풀려 안내한다.
    const elapsedSec = Math.max(0, now - bucket.last) / 1000;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsedSec * this.#refillPerSec);
    bucket.last = now;

    if (bucket.tokens < 1) {
      this.#rejected++;
      return { ok: false, retryAfterSec: Math.ceil((1 - bucket.tokens) / this.#refillPerSec) };
    }

    bucket.tokens -= 1;
    return { ok: true };
  }

  // 연결이 끊긴 소켓처럼 다시 안 올 키를 즉시 정리한다.
  drop(key: string): void {
    this.#buckets.delete(key);
  }

  // 오래 안 쓴 버킷을 청소해 메모리 누수를 막는다.
  // IP처럼 "끝났다"는 신호가 없는 키는 이 방식으로만 회수할 수 있다.
  sweep(idleMs: number, now: number = Date.now()): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.last > idleMs) this.#buckets.delete(key);
    }
  }

  stats(): TokenBucketStats {
    return {
      buckets: this.#buckets.size,
      rejected: this.#rejected,
      capacity: this.#capacity,
      refillPerSec: this.#refillPerSec,
    };
  }

  // 테스트 재실행용.
  reset(): void {
    this.#buckets.clear();
    this.#rejected = 0;
  }
}
