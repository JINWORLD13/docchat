// 서버(server/types.ts)와 맞춰둔 계약.
//
// 지금은 server/와 web/이 각각 독립 패키지라 타입을 손으로 맞춰둔다.
// 규모가 커지면 packages/shared 같은 공용 패키지로 빼서 한 곳에서 관리하는 게
// 맞다. 다만 지금 단계에서 워크스페이스를 도입하면 빌드 설정만 복잡해지고
// 얻는 게 적어서, "복사해두고 서로 참조하는 주석을 남기는" 쪽을 택했다.

// --- 계정 ---

export interface Me {
  id: string;
  username: string;
  displayName: string;
  isGuest: boolean;
}

// --- 문서 ---

export interface DocumentSummary {
  id: number;
  filename: string;
  uploaded_at: string;
  chunk_count: number;
}

export interface DocumentDetail {
  id: number;
  filename: string;
  content: string;
}

// --- 질문 응답 (SSE) ---

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

// 서버가 흘려보내는 SSE 이벤트. type으로 갈리는 유니온이라, 분기해서 좁히면
// 그 갈래에만 있는 필드에 안전하게 접근할 수 있다.
export type ChatEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "delta"; text: string }
  | { type: "refusal"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: Usage };

// 이벤트 종류별 핸들러. 매핑 타입으로 만들어서, ChatEvent에 종류를 하나
// 추가하면 핸들러 자리도 자동으로 생긴다 (직접 나열하면 빠뜨리기 쉽다).
export type ChatHandlers = {
  [E in ChatEvent as E["type"]]?: (event: E) => void;
};

// --- 대시보드 지표 ---

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface MetricsResponse {
  cache: { hits: number; misses: number; hitRate: number; keys: number };
  readPool: PoolStats;
  writePool: PoolStats;
  mediaPool: PoolStats;
  rateLimit: { buckets: number; rejected: number; capacity: number; refillPerSec: number };
  admission: {
    inFlight: number;
    queued: number;
    maxInFlight: number;
    maxQueue: number;
    maxQueueWaitMs: number;
    timedOut: number;
    rejected: number;
  };
  // probing: 쿨다운은 지났고 복구를 확인하는 시험 요청 하나가 나가 있는 구간.
  // open과 따로 받는 이유는 이때도 나머지 요청은 계속 막히기 때문이다 —
  // open만 보면 화면이 "정상"이라고 말해버린다(server/breaker.ts).
  breaker: { open: boolean; consecutiveFailures: number; reopensInMs: number; probing: boolean };
  // 임베딩 전용 회로. 생성과 나눠 둔 이유는 server/breaker.ts에 있다 —
  // 생성이 죽으면 출처만 돌려줄 수 있지만, 임베딩이 죽으면 검색조차 못 한다.
  embedBreaker: { open: boolean; consecutiveFailures: number; reopensInMs: number; probing: boolean };
  // 로컬 생성(Ollama) 회로. GENERATORS 체인에 ollama가 없으면 늘 닫혀 있다.
  localBreaker: { open: boolean; consecutiveFailures: number; reopensInMs: number; probing: boolean };
  realtime: { rooms: number; users: number; messagesRejected: number };
  faults: { llmFail: boolean };
}

// 트래픽 폭주 주입 결과 집계.
export interface BurstTally {
  ok: number;
  rejected: number;
  degraded: number;
  refused: number;
  error: number;
}
