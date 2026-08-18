// RAG 코어가 주고받는 값과, 코어가 바깥세상에 요구하는 능력(포트)의 정의.
//
// 이 파일과 engine.ts는 express·pg·@google/genai를 import하지 않는다.
// 그게 "코어"라는 말의 유일한 정의다. 이 규칙이 지켜지는 한 코어는 다른 앱
// (Teams 봇, CLI, 사내 위키 봇)으로 그대로 옮겨갈 수 있고, 한 번이라도 어기면
// 그 순간 다시 DocChat 전용 코드가 된다.
// 검증 방법도 그래서 간단하다 — 이 디렉터리에서 저 셋을 grep 해서 안 나오면 된다.

// 검색으로 뽑아온 청크 하나. 생성기가 프롬프트를 만들 때,
// 코어가 출처를 내려보낼 때 같은 모양을 쓴다.
//
// interface가 아니라 type인 이유: pg의 query<R>는 R이 "컬럼명 → 값" 인덱스
// 시그니처를 만족하길 요구하는데, interface는 그 조건을 자동으로 만족하지
// 않는다(나중에 선언 병합으로 필드가 추가될 수 있어서). type 별칭은 만족한다.
export type RetrievedChunk = {
  content: string;
  filename: string;
  similarity: number;
};

// 생성기가 흘려보내는 조각.
// 실제 Gemini 응답과 mock 응답이 둘 다 이 모양을 만족하게 해서,
// 소비하는 쪽(코어)은 어느 쪽인지 신경 쓰지 않아도 되게 했다.
export interface AnswerChunk {
  text?: string | undefined;
  usageMetadata?:
    | {
        promptTokenCount?: number | undefined;
        candidatesTokenCount?: number | undefined;
      }
    | undefined;
}

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

// 코어가 내보내는 이벤트. 이게 코어와 바깥의 유일한 접점이다.
//
// 코어가 res를 직접 만지지 않고 이 이벤트만 흘려보내기 때문에, 받는 쪽을
// 갈아끼우는 것만으로 다른 앱이 된다 — SSE 어댑터는 `data: `로 감싸고,
// Teams 어댑터는 Adaptive Card로 바꾸고, CLI는 그냥 출력하면 된다.
export type RagEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "delta"; text: string }
  | { type: "refusal"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: Usage };

// 질문에 첨부된 이미지.
//
// bytes가 아니라 데이터를 통째로 받는 이유: 코어는 이미지가 어디 있는지
// (DB인지 S3인지) 몰라야 한다. id만 받으면 코어가 저장소를 알아야 하므로,
// 읽어오는 일은 전송 계층(routes/chat.ts)에 두고 코어는 내용물만 받는다.
// Buffer가 아니라 Uint8Array인 이유도 같다 — Buffer는 Node 전용이라 코어가
// 브라우저·다른 런타임으로 못 옮겨간다. Buffer는 Uint8Array의 하위 타입이라
// Node 쪽에서는 그냥 넘기면 된다.
export interface QuestionImage {
  readonly mime: string;
  readonly data: Uint8Array;
}

// 이 요청이 열람할 수 있는 범위.
//
// 지금은 groups가 항상 null(제한 없음)이다. 앱에 로그인이 생긴 뒤에도 그렇다 —
// 세션은 "들어온 사람인가"까지만 답하고, "이 문서를 볼 수 있는가"는 문서 쪽에
// 소유자·그룹이 적혀 있어야 답할 수 있는데 그게 아직 없기 때문이다.
// 인증이 있다고 인가가 따라오지는 않는다.
//
// 그런데도 이 인자를 지금 넣어둔 이유는, 나중에 붙이면 늦기 때문이다.
// 이 인자가 선택(optional)이면
// 새 저장소 어댑터를 짤 때 안 넘겨도 컴파일이 통과하고, 그러면 남의 문서가
// 조용히 검색 결과에 섞인다 — 권한 사고는 대개 이런 식으로 난다.
// 필수 인자로 못박아두면 컴파일러가 대신 감시해준다.
export interface Scope {
  // null이면 제한 없음. Keycloak을 붙이면 토큰에서 꺼낸 그룹 목록이 여기 들어오고,
  // 저장소 어댑터는 반드시 이 값으로 검색 자체를 좁혀야 한다(LLM에게 부탁하는 게
  // 아니라, 애초에 후보에서 빼는 방식으로).
  readonly groups: readonly string[] | null;
}

// --- 포트: 코어가 바깥에 요구하는 능력 ---

export interface Embedder {
  embedQuery(text: string): Promise<number[]>;
}

export interface VectorStore {
  // scope는 선택 인자가 아니다. 위 Scope 주석 참고.
  search(vector: number[], k: number, scope: Scope): Promise<RetrievedChunk[]>;
}

// 이름이 AnswerGenerator인 이유: Generator는 TS 전역 타입(제너레이터 객체)이라
// 그대로 쓰면 가려버린다.
export interface AnswerGenerator {
  stream(
    question: string,
    contexts: RetrievedChunk[],
    signal: AbortSignal,
    // 있으면 질문과 함께 보고 답한다. 멀티모달이 아닌 생성기(로컬 소형 모델 등)를
    // 어댑터로 끼우는 앱은 이 인자를 무시하면 된다 — 그래서 필수가 아니다.
    image?: QuestionImage | undefined
  ): AsyncIterable<AnswerChunk>;
}

export interface QueryLogRecord {
  question: string;
  answer: string | null;
  refused: boolean;
  topSimilarity: number;
  promptTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

// 관측용. 코어는 이게 어디에 어떻게 쌓이는지 모른다(Postgres든 파일이든).
// 실패해도 사용자 응답에 영향을 주면 안 되므로 반환값이 void다 — 코어는
// 기다리지 않는다.
export interface QueryLogger {
  log(record: QueryLogRecord): void;
}

// 의존성이 지금 "죽어 있어서" 부를 수 없다는 신호.
//
// 회로 차단기를 코어에 두지 않은 이유가 여기 있다. 건강 상태를 추적하는 건
// 외부 호출을 실제로 하는 어댑터의 일이고, 코어는 "못 쓴다"는 사실만 알면 된다.
// 그래야 회로차단기를 안 쓰는 다른 앱에서도 코어가 그대로 돈다.
//
// 반대로 "못 쓸 때 무엇을 할지"(거절할지, 출처만 돌려줄지)는 코어의 정책이라
// 코어가 정한다. 그래서 이 에러는 어댑터가 던지고 코어가 해석한다.
export class DependencyUnavailableError extends Error {
  readonly dependency: string;

  constructor(dependency: string) {
    super(`의존성을 지금 사용할 수 없습니다: ${dependency}`);
    this.name = "DependencyUnavailableError";
    this.dependency = dependency;
  }
}
