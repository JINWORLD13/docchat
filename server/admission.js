// 과부하 제어(admission control).
//
// 결정: 과부하 상황에서 들어오는 요청을 전부 받아 큐에 무한정 쌓으면,
// 모든 요청의 대기 시간이 폭증하고 결국 다 같이 타임아웃으로 죽는다
// (cascading failure). 그래서 "동시에 처리하는 무거운 요청 수"에 상한을 둔다.
// 상한을 넘으면 짧은 대기열에 잠깐 담고, 그 대기열마저 꽉 차면 429로 즉시
// 거절한다(load shedding). 일부를 빨리 포기해서 나머지를 정상 지연으로 지킨다.
//
// 왜 이 방식인가:
// - 무한 큐: 지연이 무한히 늘어 최악. 안 씀.
// - 즉시 거절만: 살짝 몰릴 때도 다 튕겨 손님 경험이 나쁨.
// - 상한 + 짧은 큐 + 초과 시 거절: 순간 스파이크는 큐로 흡수하고,
//   지속 과부하는 거절로 방어. 둘의 절충.

let inFlight = 0; // 지금 처리 중인 요청 수
const waiters = []; // 자리를 기다리는 요청들(resolve 함수)

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 8); // 동시 처리 상한
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20); // 대기열 상한

// 자리를 얻으면 true, 과부하로 거절되면 false.
export function acquire() {
  if (inFlight < MAX_INFLIGHT) {
    inFlight++;
    return Promise.resolve(true);
  }
  if (waiters.length >= MAX_QUEUE) {
    return Promise.resolve(false); // 대기열까지 꽉 참 → 거절
  }
  return new Promise((resolve) => waiters.push(resolve));
}

// 처리가 끝나면 반드시 호출해 자리를 넘겨준다.
export function release() {
  const next = waiters.shift();
  if (next) {
    next(true); // 대기 중이던 요청에게 자리 양보 (inFlight 유지)
  } else {
    inFlight--;
  }
}

export function admissionStats() {
  return { inFlight, queued: waiters.length, maxInFlight: MAX_INFLIGHT, maxQueue: MAX_QUEUE };
}
