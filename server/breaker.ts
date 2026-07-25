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
let probing = false; // 반열림(half-open) 상태에서 시험 요청이 나가 있는지

const THRESHOLD = Number(process.env.BREAKER_THRESHOLD || 5); // 연속 실패 몇 번에 열까
const COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 10000); // 얼마나 열어둘까

export interface BreakerState {
  open: boolean;
  consecutiveFailures: number;
  reopensInMs: number;
}

// 쿨다운이 아직 안 끝났나. 부수효과 없는 순수 검사 — 상태를 보고만 할 때 쓴다.
function coolingDown(): boolean {
  return Date.now() < openUntil;
}

// 지금 회로가 열려 있나(= LLM을 건너뛸까).
//
// 주의: 이 함수는 반열림 시험권을 소비한다(아래 probing). 요청 경로에서만
// 부르고, 상태를 읽기만 할 때는 breakerState()를 쓴다.
//
// 쿨다운이 끝나는 순간이 함정이다. 그때 대기 중이던 요청이 한꺼번에(최대
// MAX_INFLIGHT=8) 죽어 있을지도 모르는 API로 동시에 몰려간다. 회로를 둔 이유가
// "죽은 의존성을 계속 두들기지 않는 것"인데, 복구를 확인하는 그 순간에 정확히
// 그 짓을 하는 셈이다.
//
// 그래서 쿨다운 직후에는 한 건만 통과시킨다(반열림). 그 한 건의 결과로
// 판정한다 — 성공이면 회로를 닫고, 실패면 다시 쿨다운만큼 열어둔다.
export function isOpen(): boolean {
  if (coolingDown()) return true;
  if (consecutiveFailures < THRESHOLD) return false;

  // 여기부터는 "쿨다운은 지났지만 아직 복구를 확인 못 한" 구간이다.
  // 시험 요청 하나만 내보내고 나머지는 계속 막는다.
  if (probing) return true;
  probing = true;
  return false;
}

export function onSuccess(): void {
  consecutiveFailures = 0; // 한 번 성공하면 카운터 리셋
  probing = false;
}

export function onFailure(): void {
  consecutiveFailures++;
  probing = false;
  if (consecutiveFailures >= THRESHOLD) {
    openUntil = Date.now() + COOLDOWN_MS; // 회로 열기
  }
}

// 대시보드·메트릭용. isOpen()과 달리 아무것도 소비하지 않는다 —
// 예전엔 여기서 isOpen()을 불렀는데, 그러면 대시보드가 1초마다 상태를 읽는
// 것만으로 복구 시험권을 가로채 실제 요청이 영영 회로를 못 열게 된다.
export function breakerState(): BreakerState {
  const open = coolingDown();
  return {
    open,
    consecutiveFailures,
    reopensInMs: open ? openUntil - Date.now() : 0,
  };
}

// 데모 재실행용. 회로 상태를 초기화한다.
export function reset(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  probing = false;
}
