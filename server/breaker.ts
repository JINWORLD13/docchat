// 회로 차단기(circuit breaker) — 외부 LLM API 전용.
//
// 문제: 외부 의존성(Gemini)이 장애가 나면, 재시도까지 겹쳐 요청마다 몇 초씩
// 매달렸다가 실패한다. 그 사이 느린 요청이 쌓여 서버 전체가 같이 느려진다
// (하나의 죽은 의존성이 서비스 전체를 끌어내림).
//
// 결정: 연속 실패가 임계치를 넘으면 회로를 "열어서" 일정 시간 동안 LLM을
// 아예 부르지 않는다. 그동안은 즉시 대체 응답(degradation)으로 넘긴다.
// 죽은 API를 계속 두들기지 않고 빨리 포기하는 게, 한 번의 실수도 용납 안 되는
// 서비스에서 전체를 지키는 방법이다. 쿨다운이 지나면 다시 시도해 본다.

let consecutiveFailures = 0;
let openUntil = 0; // 이 시각까지 회로가 열려 있음 (epoch ms)

const THRESHOLD = Number(process.env.BREAKER_THRESHOLD || 5); // 연속 실패 몇 번에 열까
const COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 10000); // 얼마나 열어둘까

export interface BreakerState {
  open: boolean;
  consecutiveFailures: number;
  reopensInMs: number;
}

// 지금 회로가 열려 있나(= LLM을 건너뛸까).
export function isOpen(): boolean {
  return Date.now() < openUntil;
}

export function onSuccess(): void {
  consecutiveFailures = 0; // 한 번 성공하면 카운터 리셋
}

export function onFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= THRESHOLD) {
    openUntil = Date.now() + COOLDOWN_MS; // 회로 열기
  }
}

export function breakerState(): BreakerState {
  return {
    open: isOpen(),
    consecutiveFailures,
    reopensInMs: isOpen() ? openUntil - Date.now() : 0,
  };
}

// 데모 재실행용. 회로 상태를 초기화한다.
export function reset(): void {
  consecutiveFailures = 0;
  openUntil = 0;
}
