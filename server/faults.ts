// 런타임 장애 주입 스위치.
// 대시보드 버튼으로 껐다 켤 수 있게, 환경변수(고정)가 아니라 이 가변 객체를 본다.
// 포폴 데모에서 "LLM 장애" 버튼을 누르면 여기 llmFail이 true가 되고,
// circuit breaker와 degradation이 실제로 작동하는 걸 실시간으로 보여준다.

export interface Faults {
  llmFail: boolean;
}

export const faults: Faults = {
  llmFail: process.env.LLM_FAIL === "1", // 시작값은 환경변수, 이후 런타임에 토글
};
