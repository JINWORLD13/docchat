// 카카오톡 스킬 어댑터의 순수 부분 — 페이로드 해석, 시간 예산 수집, 응답 조립.
//
// 웹(SSE)과 카카오의 결정적 차이는 "언제 보내느냐"다. SSE는 조각을 흘려보내면
// 되지만, 오픈빌더 스킬은 5초 안에 완성된 JSON 하나를 돌려줘야 하고 스트리밍이
// 없다. 그래서 이 어댑터의 일은 이벤트 스트림을 "예산 안에 모으는 것"이다 —
// 예산 안에 끝나면 완답, 못 끝나면 콜백(비동기 답장)으로 넘기거나 부분이라도
// 전한다. 그 판단에 필요한 재료를 여기서 만든다.
//
// HTTP·admission·rate limit은 routes/kakao.ts에 있다. 이 파일은 express를
// 모른다 — 그래서 아래 전부가 가짜 이벤트만으로 테스트된다(kakao.test.ts).

import type { ChatEvent, SourceRef } from "./types.ts";

// --- 오픈빌더가 보내는 것 ---

export interface SkillRequest {
  utterance: string;
  // 제한(rate limit)의 키. 카카오 요청은 전부 카카오 서버 IP로 오므로
  // IP 대신 이 값으로 사용자를 구분해야 한다.
  userId: string;
  // 콜백(비동기 답장)이 봇에 활성화돼 있으면 온다. 없으면 5초가 전부다.
  callbackUrl: string | null;
}

const MAX_UTTERANCE = 1000; // 잘라만 둔다. 진짜 길이 검증은 엔진(validate)이 한다.

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// 소켓 페이로드(realtime/payload.ts)와 같은 이유로 모양을 하나씩 확인한다 —
// 이 주소를 아는 누구든 아무 JSON이나 보낼 수 있다.
export function parseSkillPayload(body: unknown): SkillRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const userRequest = (body as { userRequest?: unknown }).userRequest;
  if (typeof userRequest !== "object" || userRequest === null) return null;

  const req = userRequest as { utterance?: unknown; user?: unknown; callbackUrl?: unknown };
  const utterance = str(req.utterance).trim().slice(0, MAX_UTTERANCE);
  if (!utterance) return null;

  const user = typeof req.user === "object" && req.user !== null ? (req.user as { id?: unknown }) : {};
  const userId = str(user.id) || "unknown";

  // 콜백 주소는 https만 받는다. 이 값은 요청 본문에서 오므로, 주소를 아는
  // 제3자가 가짜 페이로드로 우리 답변을 임의 서버에 배달시킬 수 있다 —
  // 스킬 URL의 토큰(routes/kakao.ts)이 1차 방어고 이건 2차다.
  const callbackUrl = str(req.callbackUrl);
  return {
    utterance,
    userId,
    callbackUrl: callbackUrl.startsWith("https://") ? callbackUrl : null,
  };
}

// --- 이벤트 스트림을 예산 안에 모으기 ---

export interface CollectedAnswer {
  kind: "answer" | "refusal" | "error";
  text: string;
  sources: SourceRef[];
}

export interface BudgetedCollect {
  // 예산이 끝났거나 스트림이 끝났거나, 먼저 오는 쪽. finished가 false면
  // snapshot은 그 순간까지의 부분 결과다.
  first: Promise<{ snapshot: CollectedAnswer; finished: boolean }>;
  // 스트림의 끝까지 모은 결과. 콜백 답장이 이걸 기다린다.
  full: Promise<CollectedAnswer>;
}

export function collectWithBudget(
  events: AsyncIterable<ChatEvent>,
  budgetMs: number
): BudgetedCollect {
  const state: CollectedAnswer = { kind: "answer", text: "", sources: [] };
  const snapshot = (): CollectedAnswer => ({ ...state, sources: [...state.sources] });

  const full = (async (): Promise<CollectedAnswer> => {
    try {
      for await (const event of events) {
        switch (event.type) {
          case "sources":
            state.sources = event.sources;
            break;
          case "delta":
            state.text += event.text;
            break;
          case "refusal":
            state.kind = "refusal";
            state.text = event.message;
            break;
          case "error":
            state.kind = "error";
            state.text = event.message;
            break;
          case "done":
            break; // 토큰 수는 메신저에서 보여줄 곳이 없다
          default: {
            // 코어에 이벤트가 추가되면 여기서 컴파일이 깨진다 (web/src/api.ts와 같은 장치).
            const unhandled: never = event;
            console.warn("카카오 어댑터가 처리하지 않은 이벤트:", unhandled);
          }
        }
      }
    } catch (e) {
      // 코어는 자기 실패를 error 이벤트로 바꿔 내보내므로, 여기 오는 건
      // 스트림 자체가 깨진 경우다.
      console.error("kakao collect error:", e instanceof Error ? e.message : e);
      state.kind = "error";
      if (!state.text) state.text = "요청 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.";
    }
    return snapshot();
  })();

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<{ snapshot: CollectedAnswer; finished: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ snapshot: snapshot(), finished: false }), budgetMs);
  });
  const first = Promise.race([
    full.then((s) => {
      clearTimeout(timer); // 스트림이 먼저 끝났으면 타이머가 매달려 있을 이유가 없다
      return { snapshot: s, finished: true };
    }),
    budget,
  ]);

  return { first, full };
}

// --- 스킬 응답 조립 ---

// simpleText 한 개의 길이 제한(오픈빌더 기준 1000자). 넘기면 카카오가 응답
// 전체를 실패로 처리해 "말이 길어서 잘렸다"가 아니라 "아무 말도 안 한다"가 된다.
const TEXT_LIMIT = 1000;

// 출처는 파일명만 짧게 단다. 웹처럼 미리보기 스니펫까지 붙이면 본문이 밀려난다.
function sourcesBlock(sources: SourceRef[]): string {
  if (sources.length === 0) return "";
  const lines = sources.slice(0, 3).map((s) => `· ${s.filename} (유사도 ${s.similarity})`);
  return `\n\n참고한 문서\n${lines.join("\n")}`;
}

export function skillText(result: CollectedAnswer, complete: boolean): string {
  if (result.kind !== "answer") return result.text; // 거절·오류 문구는 코어가 만든 그대로

  // 예산 안에 못 끝냈고 콜백도 없어 부분만 전하는 경우.
  if (!complete) {
    if (!result.text) {
      return "답변을 만드는 데 시간이 걸리고 있어요. 잠시 후 다시 질문해주세요.";
    }
    const notice = "\n\n(시간 제한으로 여기까지만 전해드려요)";
    return truncate(result.text, TEXT_LIMIT - notice.length) + notice;
  }

  const tail = sourcesBlock(result.sources);
  // 본문을 먼저 자른다 — 출처가 잘리면 어느 문서에서 왔는지가 사라지는데,
  // 그건 이 앱이 답변보다 아끼는 정보다.
  return truncate(result.text, TEXT_LIMIT - tail.length) + tail;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)) + "…";
}

// 오픈빌더 스킬 응답. 필요한 두 모양만 정의한다.
export interface SkillResponse {
  version: "2.0";
  template?: { outputs: Array<{ simpleText: { text: string } }> };
  useCallback?: boolean;
  data?: { text: string };
}

export function simpleTextResponse(text: string): SkillResponse {
  return { version: "2.0", template: { outputs: [{ simpleText: { text } }] } };
}

// 콜백 접수 응답: 이걸 5초 안에 돌려주면 카카오가 "생각 중" 문구를 보여주고,
// 우리는 callbackUrl로 완성된 답을 (1분 안에) 따로 보낸다.
export function callbackWaitResponse(text: string): SkillResponse {
  return { version: "2.0", useCallback: true, data: { text } };
}
