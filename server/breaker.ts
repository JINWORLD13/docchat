// 회로 차단기(circuit breaker) — 외부 API 전용.
//
// 문제: 외부 의존성(Gemini)이 장애가 나면, 재시도까지 겹쳐 요청마다 몇 초씩
// 매달렸다가 실패한다. 그 사이 느린 요청이 쌓여 서버 전체가 같이 느려진다
// (하나의 죽은 의존성이 서비스 전체를 끌어내림).
//
// 결정: 연속 실패가 임계치를 넘으면 회로를 "열어서" 일정 시간 동안 그 API를
// 아예 부르지 않는다. 그동안은 즉시 대체 응답(degradation)으로 넘긴다.
// 죽은 API를 계속 두들기지 않고 빨리 포기하는 게, 한 번의 실수도 용납 안 되는
// 서비스에서 전체를 지키는 방법이다. 쿨다운이 지나면 다시 시도해 본다.
//
// 왜 인스턴스를 두 개 두는가:
// 처음엔 회로가 생성(LLM)에만 걸려 있었다. 그런데 질문 경로가 외부로 나가는
// 지점은 둘이다 — 질문을 벡터로 바꾸는 임베딩과, 답변을 만드는 생성.
// 임베딩 호출이 회로 밖에 있어서, 임베딩 API가 죽으면 회로는 영영 안 열리고
// 요청마다 재시도(0.5+1+2초)를 다 소진한 뒤 500이 나갔다. 처리 슬롯을 그 시간
// 내내 잡은 채로. "죽은 의존성에 매달리지 않는다"는 이 프로젝트의 주장이
// 정작 절반만 지켜지고 있었던 셈이다.
//
// 그렇다고 하나로 합칠 수는 없다. 둘은 실패했을 때 할 수 있는 일이 다르다.
//   생성 실패   → 출처는 이미 찾았으니 그것만 돌려준다 (degradation)
//   임베딩 실패 → 검색을 시작할 수조차 없다. 돌려줄 출처가 없다
// 하나로 묶으면 생성 장애가 임베딩까지 막아, 출처를 돌려줄 수 있는 상황에서도
// 못 돌려주게 된다. 그래서 회로를 나누고, 각자 할 수 있는 최선을 하게 뒀다.

export interface BreakerState {
  open: boolean;
  consecutiveFailures: number;
  reopensInMs: number;
}

export interface Breaker {
  isOpen(): boolean;
  onSuccess(): void;
  onFailure(): void;
  state(): BreakerState;
  reset(): void;
}

export function createBreaker(threshold: number, cooldownMs: number): Breaker {
  let consecutiveFailures = 0;
  let openUntil = 0; // 이 시각까지 회로가 열려 있음 (epoch ms)
  let probing = false; // 반열림(half-open) 상태에서 시험 요청이 나가 있는지

  // 쿨다운이 아직 안 끝났나. 부수효과 없는 순수 검사 — 상태를 보고만 할 때 쓴다.
  const coolingDown = (): boolean => Date.now() < openUntil;

  return {
    // 지금 회로가 열려 있나(= 외부 호출을 건너뛸까).
    //
    // 주의: 이 함수는 반열림 시험권을 소비한다(아래 probing). 요청 경로에서만
    // 부르고, 상태를 읽기만 할 때는 state()를 쓴다.
    //
    // 쿨다운이 끝나는 순간이 함정이다. 그때 대기 중이던 요청이 한꺼번에(최대
    // MAX_INFLIGHT=8) 죽어 있을지도 모르는 API로 동시에 몰려간다. 회로를 둔 이유가
    // "죽은 의존성을 계속 두들기지 않는 것"인데, 복구를 확인하는 그 순간에 정확히
    // 그 짓을 하는 셈이다.
    //
    // 그래서 쿨다운 직후에는 한 건만 통과시킨다(반열림). 그 한 건의 결과로
    // 판정한다 — 성공이면 회로를 닫고, 실패면 다시 쿨다운만큼 열어둔다.
    isOpen(): boolean {
      if (coolingDown()) return true;
      if (consecutiveFailures < threshold) return false;

      // 여기부터는 "쿨다운은 지났지만 아직 복구를 확인 못 한" 구간이다.
      // 시험 요청 하나만 내보내고 나머지는 계속 막는다.
      if (probing) return true;
      probing = true;
      return false;
    },

    onSuccess(): void {
      consecutiveFailures = 0; // 한 번 성공하면 카운터 리셋
      probing = false;
    },

    onFailure(): void {
      consecutiveFailures++;
      probing = false;
      if (consecutiveFailures >= threshold) {
        openUntil = Date.now() + cooldownMs; // 회로 열기
      }
    },

    // 대시보드·메트릭용. isOpen()과 달리 아무것도 소비하지 않는다 —
    // 예전엔 여기서 isOpen()을 불렀는데, 그러면 대시보드가 1초마다 상태를 읽는
    // 것만으로 복구 시험권을 가로채 실제 요청이 영영 회로를 못 열게 된다.
    state(): BreakerState {
      const open = coolingDown();
      return {
        open,
        consecutiveFailures,
        reopensInMs: open ? openUntil - Date.now() : 0,
      };
    },

    // 데모 재실행용. 회로 상태를 초기화한다.
    reset(): void {
      consecutiveFailures = 0;
      openUntil = 0;
      probing = false;
    },
  };
}

const THRESHOLD = Number(process.env.BREAKER_THRESHOLD || 5); // 연속 실패 몇 번에 열까
const COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 10000); // 얼마나 열어둘까

// 답변 생성(LLM). 대시보드가 "회로 상태"라고 부르는 것이 이쪽이다.
export const llm = createBreaker(THRESHOLD, COOLDOWN_MS);

// 질문 임베딩. 같은 벤더지만 실패했을 때 할 수 있는 일이 달라서 따로 둔다.
export const embed = createBreaker(THRESHOLD, COOLDOWN_MS);

// 로컬 생성(Ollama). 클라우드(llm)와 나누는 이유는 역할이 달라서다 —
// 로컬은 1차 공급자고 뒤에 보루(Gemini)가 있다. 로컬이 "멈춰 있는" 상태
// (연결은 받는데 응답이 없음)면 요청마다 타임아웃(기본 60초)을 다 기다린 뒤에야
// 보루로 넘어가는데, 이 회로가 열리면 그 대기 없이 즉시 넘어간다.
// llm 회로에 합치면 로컬 장애가 보루까지 잠가서 폴백 자체가 무의미해진다.
export const local = createBreaker(THRESHOLD, COOLDOWN_MS);

// 아래 함수들은 LLM 회로를 가리킨다. 부르는 쪽(routes/chat.ts, index.ts)이
// 대부분 생성 쪽이라 이름을 짧게 유지한다.
export const isOpen = (): boolean => llm.isOpen();
export const onSuccess = (): void => llm.onSuccess();
export const onFailure = (): void => llm.onFailure();
export const breakerState = (): BreakerState => llm.state();

// 데모 재실행용. 회로를 전부 함께 초기화한다 — 대시보드의 "리셋"은
// "장애 이전 상태로 돌린다"는 뜻이므로 일부만 남으면 안 된다.
export function reset(): void {
  llm.reset();
  embed.reset();
  local.reset();
}
