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

// 검색으로 뽑아온 청크 하나. gemini.ts가 프롬프트를 만들 때,
// chat 라우트가 출처를 내려보낼 때 같은 모양을 쓴다.
//
// interface가 아니라 type인 이유: pg의 query<R>는 R이 "컬럼명 → 값" 인덱스
// 시그니처를 만족하길 요구하는데, interface는 그 조건을 자동으로 만족하지
// 않는다(나중에 선언 병합으로 필드가 추가될 수 있어서). type 별칭은 만족한다.
export type RetrievedChunk = {
  content: string;
  filename: string;
  similarity: number;
};

// LLM 스트림이 흘려보내는 조각.
// 실제 Gemini 응답과 mock 응답이 둘 다 이 모양을 만족하게 해서,
// 소비하는 쪽(chat 라우트)은 어느 쪽인지 신경 쓰지 않아도 되게 했다.
export interface AnswerChunk {
  text?: string | undefined;
  usageMetadata?:
    | {
        promptTokenCount?: number | undefined;
        candidatesTokenCount?: number | undefined;
      }
    | undefined;
}

// 사용자에게 내려보내는 SSE 이벤트.
// 유니온으로 못박아두면, 프런트에서 이벤트 종류별로 분기할 때 어떤 필드가
// 존재하는지를 컴파일러가 좁혀준다(= 없는 필드 접근을 미리 막는다).
export interface SourceRef {
  index: number;
  filename: string;
  snippet: string;
  similarity: number;
}

export interface Usage {
  promptTokens: number | null;
  outputTokens: number | null;
}

export type ChatEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "delta"; text: string }
  | { type: "refusal"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: Usage };

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
  realtime: RealtimeStats;
  faults: Faults;
}
