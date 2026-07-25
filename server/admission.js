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
//
// 큐 길이만으로는 부족하다:
// 대기열 길이에 상한을 둬도, 앞의 요청들이 오래 걸리면 큐 안에서 무한정
// 기다릴 수 있다. "무한 대기를 없앴다"고 말하려면 길이뿐 아니라 시간에도
// 상한이 있어야 한다. 그래서 대기에 데드라인을 두고, 그 안에 자리가 안 나면
// 기다리길 포기하고 429로 돌려보낸다. 어차피 그때쯤이면 사용자도 떠났고,
// 늦게 처리해봐야 아무도 안 받아가는 응답에 자원만 쓰는 셈이다.

let inFlight = 0; // 지금 처리 중인 요청 수
const waiters = []; // 자리를 기다리는 요청들

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 8); // 동시 처리 상한
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20); // 대기열 길이 상한
const MAX_QUEUE_WAIT_MS = Number(process.env.MAX_QUEUE_WAIT_MS || 2000); // 대기열 시간 상한

let timedOut = 0; // 관측용: 대기하다 포기한 요청 수
let rejected = 0; // 관측용: 큐가 꽉 차 즉시 거절한 요청 수

// 대기자는 타임아웃과 release() 양쪽에서 깨울 수 있다.
// 먼저 도착한 쪽만 이기고 나머지는 무시되도록 한 번만 확정한다.
function settle(w, value) {
  if (w.settled) return false;
  w.settled = true;
  clearTimeout(w.timer);
  w.resolve(value);
  return true;
}

// 자리를 얻으면 true, 과부하로 거절되면 false.
export function acquire() {
  if (inFlight < MAX_INFLIGHT) {
    inFlight++;
    return Promise.resolve(true);
  }

  if (waiters.length >= MAX_QUEUE) {
    rejected++;
    return Promise.resolve(false); // 대기열까지 꽉 참 → 즉시 거절
  }

  return new Promise((resolve) => {
    const w = { resolve, settled: false, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1); // 큐에서 빼고
      timedOut++;
      settle(w, false); // 기다리길 포기 → 429
    }, MAX_QUEUE_WAIT_MS);
    waiters.push(w);
  });
}

// 처리가 끝나면 반드시 호출해 자리를 넘겨준다.
export function release() {
  // 앞에서부터 아직 살아 있는 대기자를 찾아 자리를 넘긴다.
  // (타임아웃된 대기자는 이미 큐에서 빠졌지만, 경합에 대비해 방어적으로 건너뛴다.)
  while (waiters.length > 0) {
    const next = waiters.shift();
    if (settle(next, true)) return; // 자리 양보 — inFlight는 그대로 유지
  }
  inFlight--; // 기다리는 사람이 없으면 자리를 비운다
}

export function admissionStats() {
  return {
    inFlight,
    queued: waiters.length,
    maxInFlight: MAX_INFLIGHT,
    maxQueue: MAX_QUEUE,
    maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    timedOut, // 대기하다 포기 (큐가 길어서 느려졌다는 신호)
    rejected, // 큐가 꽉 차 즉시 거절 (과부하가 지속된다는 신호)
  };
}

// 테스트/데모 재실행용.
export function reset() {
  while (waiters.length > 0) settle(waiters.shift(), false);
  inFlight = 0;
  timedOut = 0;
  rejected = 0;
}
