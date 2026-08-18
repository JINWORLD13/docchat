// 문서 Q&A 쪽에서 모듈들이 주고받는 값의 모양.
// (실시간 채팅의 이벤트 계약은 realtime/types.ts에 따로 있다.)

// import type은 컴파일 후 완전히 사라진다. 그래서 이 파일을 읽는 스크립트가
// db.ts를 실제로 불러와 커넥션 풀을 만들어버리는 일이 없다.
import type { PoolStats } from "./db.ts";
import type { TokenBucketStats } from "./tokenbucket.ts";
import type { AdmissionStats } from "./admission.ts";
import type { BreakerState } from "./breaker.ts";
import type { Faults } from "./faults.ts";
import type { RealtimeStats } from "./realtime/types.ts";

// 질문 처리에 쓰이는 모양들은 이제 RAG 코어(rag/types.ts)가 소유한다.
// 코어는 이 앱을 모르고, 이 앱은 코어를 알아도 된다 — 의존 방향은 한쪽이다.
// 여기서 다시 내보내는 건 기존에 이 파일을 읽던 코드를 그대로 두기 위해서다.
//
// 사용자에게 내려보내는 SSE 이벤트를 유니온으로 못박아두면, 프런트에서 이벤트
// 종류별로 분기할 때 어떤 필드가 존재하는지를 컴파일러가 좁혀준다
// (= 없는 필드 접근을 미리 막는다). 그 유니온이 코어의 RagEvent다.
export type {
  RetrievedChunk,
  AnswerChunk,
  AnswerGenerator,
  SourceRef,
  Usage,
  Scope,
  QuestionImage,
  RagEvent as ChatEvent,
} from "./rag/types.ts";

// --- /api/metrics 응답 ---
//
// 이 모양을 한 곳에 두는 게 TS로 옮겨서 가장 크게 득 본 부분이다.
// 대시보드, 부하 측정 스크립트, 시연 스크립트가 전부 이 응답을 읽는데,
// JS일 때는 서버에서 필드 이름을 바꿔도 읽는 쪽이 조용히 undefined를 찍었다.
// (실제로 풀을 읽기/쓰기로 쪼갠 뒤 load-chat 스크립트가 계속 없어진 m.pool을
//  읽고 있었고, 화면에 undefined가 나올 때까지 아무도 몰랐다.)
// 이제 서버와 소비자가 같은 타입을 보므로 그런 변경은 컴파일에서 걸린다.
export interface MetricsResponse {
  cache: { hits: number; misses: number; hitRate: number; keys: number };
  readPool: PoolStats;
  writePool: PoolStats;
  mediaPool: PoolStats;
  rateLimit: TokenBucketStats;
  admission: AdmissionStats;
  breaker: BreakerState; // 답변 생성(LLM) 회로
  // 질문 임베딩 회로. 생성과 나눠 두는 이유는 breaker.ts에 적어뒀다 —
  // 둘은 실패했을 때 할 수 있는 일이 다르다(출처를 돌려줄 수 있나 없나).
  embedBreaker: BreakerState;
  // 로컬 생성(Ollama) 회로. GENERATORS 체인에 ollama가 없으면 늘 닫혀 있다.
  // 노출하는 이유: 이 회로가 열리면 "로컬로 돈다"는 믿음과 달리 모든 질문이
  // 보루(Gemini)로 가고 있다는 뜻인데, 지표가 없으면 그 사실을 알 길이 없다.
  localBreaker: BreakerState;
  realtime: RealtimeStats;
  faults: Faults;
}
