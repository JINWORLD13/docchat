import type {
  BurstTally,
  ChatEvent,
  ChatHandlers,
  DocumentDetail,
  DocumentSummary,
  Me,
  MetricsResponse,
} from "./types";

const BASE = "/api";

// fetch로 받은 JSON은 실제로는 검증되지 않은 값이다. 그래서 타입 단언이
// 필요한데, 그걸 각 함수에 흩뿌리는 대신 여기 한 곳에 모았다.
// 서버 응답을 믿는다는 결정이 어디서 일어나는지 한눈에 보이게 하려고.
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// --- 세션이 끊겼을 때 ---
//
// 서버는 401을 딱 한 가지 뜻으로만 쓴다: "유효한 세션이 없다"(server/auth.ts의
// requireLogin). 권한 부족(관리자 토큰)은 403이라 여기 섞이지 않는다.
// 그래서 401은 "이 요청이 실패했다"가 아니라 "지금 로그인 상태가 아니다"로
// 읽어야 한다 — 그걸 요청별 오류 문구로 처리하면, 세션이 만료된 사람에게
// "문서 목록을 불러오지 못했습니다"가 뜨고 새로고침해도 같은 화면이 반복된다.
// 원인이 로그인인데 화면은 그 말을 한 번도 하지 않는 상태가 된다.
//
// App이 여기에 "AuthGate로 돌아가기"를 등록한다(App.tsx).
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

// 소켓 핸드셰이크가 거절당했을 때도 같은 곳으로 온다(realtime/LiveChat.tsx).
// 채팅 탭에만 앉아 있으면 HTTP 요청이 아예 안 나가서 401을 만날 일이 없다.
export function notifySessionExpired(): void {
  onSessionExpired?.();
}

// 로그인이 필요한 요청의 응답을 확인한다.
// 로그인·가입·게스트·me는 401이 정상 신호(자격 불일치 / 아직 로그인 안 됨)라
// 여기를 통과시키지 않는다.
function checkSession(res: Response): void {
  if (res.status === 401) notifySessionExpired();
}

// 에러 응답의 { error: "..." }를 꺼낸다. 본문이 JSON이 아닐 수도 있어 감싼다.
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : fallback;
  } catch {
    return fallback;
  }
}

// 문서를 바꾸는 요청(추가·수정·삭제)에 붙이는 헤더.
//
// 서버는 이 세 가지를 관리자 스위치와 같은 규칙으로 한 겹 더 막는다
// (server/admin.ts). 로컬 데모는 루프백이라 토큰 없이 통과하고, 배포하면
// 토큰이 있어야 한다.
//
// 읽기(목록·상세)에는 이 헤더를 안 붙인다. 읽기가 열려 있어서가 아니라 —
// 이제 문서 경로는 전부 로그인을 요구한다(server/index.ts) — 그 문을 세션
// 쿠키가 알아서 지나기 때문이다. 이 토큰이 답하는 질문은 "들어온 사람인가"가
// 아니라 "코퍼스를 바꿔도 되는 사람인가"라서, 읽기에는 물을 이유가 없다.
function writeHeaders(base: Record<string, string> = {}): Record<string, string> {
  return ADMIN_TOKEN ? { ...base, "x-admin-token": ADMIN_TOKEN } : base;
}

// --- 계정 ---
// 쿠키(httpOnly 세션)는 같은 오리진 fetch에 자동으로 실린다. 토큰을 다루는
// 코드가 클라이언트에 없는 이유다(server/auth.ts의 쿠키 주석).

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch(`${BASE}/auth/me`);
  if (res.status === 401) return null; // 로그인 안 됨 — 오류가 아니라 상태다
  if (!res.ok) throw new Error("로그인 상태를 확인하지 못했습니다.");
  return readJson<Me>(res);
}

export async function guestLogin(displayName: string): Promise<Me> {
  const res = await fetch(`${BASE}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "입장에 실패했습니다."));
  return readJson<Me>(res);
}

export async function login(username: string, password: string): Promise<Me> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "로그인에 실패했습니다."));
  return readJson<Me>(res);
}

export async function signup(
  username: string,
  password: string,
  displayName: string
): Promise<Me> {
  const res = await fetch(`${BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, displayName }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "가입에 실패했습니다."));
  return readJson<Me>(res);
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST" });
}

export async function fetchDocuments(): Promise<DocumentSummary[]> {
  const res = await fetch(`${BASE}/documents`);
  checkSession(res);
  if (!res.ok) throw new Error("문서 목록을 불러오지 못했습니다.");
  return readJson<DocumentSummary[]>(res);
}

export async function uploadDocument(file: File): Promise<{ id: number; filename: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/documents`, {
    method: "POST",
    headers: writeHeaders(),
    body: form,
  });
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "업로드에 실패했습니다."));
  return readJson(res);
}

export async function fetchDocument(id: number): Promise<DocumentDetail> {
  const res = await fetch(`${BASE}/documents/${id}`);
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "문서를 불러오지 못했습니다."));
  return readJson<DocumentDetail>(res);
}

export async function updateDocument(id: number, content: string): Promise<void> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: "PUT",
    headers: writeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ content }),
  });
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "수정에 실패했습니다."));
}

export async function deleteDocument(id: number): Promise<void> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: "DELETE",
    headers: writeHeaders(),
  });
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "삭제에 실패했습니다."));
}

// --- 채팅 이미지 ---

// 최대 크기는 서버(routes/images.ts)와 맞춰둔다.
// 여기서 먼저 걸러도 서버가 다시 검사한다 — 이건 사용자에게 빨리 알려주기
// 위한 것이지 방어가 아니다. 브라우저를 안 거치고 직접 요청하면 그만이다.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// 업로드는 URL이 아니라 id만 돌려받는다. 주소는 서버가 만든다 —
// 클라이언트가 주소를 정할 수 있으면 임의의 주소를 방 전체에 뿌릴 수 있다.
export async function uploadChatImage(
  file: File,
  width: number,
  height: number
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("image", file);
  form.append("width", String(width));
  form.append("height", String(height));

  const res = await fetch(`${BASE}/chat/image`, { method: "POST", body: form });
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "이미지 업로드에 실패했습니다."));
  return readJson<{ id: string }>(res);
}

// --- 대시보드(부하·장애 대응 시연) ---

export async function fetchMetrics(): Promise<MetricsResponse> {
  const res = await fetch(`${BASE}/metrics`);
  if (!res.ok) throw new Error("metrics 실패");
  return readJson<MetricsResponse>(res);
}

// 관리자 엔드포인트는 서버에서 보호된다(server/admin.ts).
// 로컬 개발은 루프백이라 토큰 없이 통과한다.
// 주의: VITE_* 값은 빌드 산출물(JS 번들)에 평문으로 들어가 방문자 누구나
// 읽을 수 있다. 그래서 VITE_ADMIN_TOKEN을 넣는 배포는 "장애 주입 데모를
// 방문자에게 공개"하는 선택이다. 외부에 잠그고 싶으면 프런트에는 토큰을
// 넣지 말고(버튼은 막힘), 필요할 때 서버 토큰으로 직접(curl) 호출한다.
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN ?? "";

async function postAdmin(path: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (ADMIN_TOKEN) headers["x-admin-token"] = ADMIN_TOKEN;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "관리자 요청에 실패했습니다."));
}

// LLM 장애 주입 on/off
export async function setFault(llmFail: boolean): Promise<void> {
  await postAdmin("/admin/fault", { llmFail });
}

// 회로·장애 상태 초기화
export async function resetDefense(): Promise<void> {
  await postAdmin("/admin/reset");
}

// 동시 count개의 질문을 쏴서(트래픽 폭주 흉내) 상태별로 집계한다.
export async function burst(count: number, question = "환불은 며칠 걸려?"): Promise<BurstTally> {
  const one = async (): Promise<keyof BurstTally> => {
    try {
      const res = await fetch(`${BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      checkSession(res);
      if (res.status === 429) {
        await res.text().catch(() => "");
        return "rejected";
      }
      const text = await res.text().catch(() => "");

      // 429 말고 다른 실패는 전부 error다. 예전엔 여기 검사가 없어서 500이든
      // 401이든 아래 문자열 매칭을 지나 "ok"로 세어졌다.
      if (!res.ok) return "error";

      // 이 경로는 SSE라 응답 코드가 언제나 200이다. 처리 중 난 오류는 본문
      // 안에 error 이벤트로 들어오므로, 상태 코드만 봐서는 실패를 못 잡는다.
      // (DB가 죽어도 200이 떨어져 "정상"으로 집계되던 자리다.)
      if (text.includes('"type":"error"')) return "error";

      if (text.includes("답변 생성이 어려워")) return "degraded";
      if (text.includes("관련 내용을 찾지 못했")) return "refused";
      return "ok";
    } catch {
      return "error";
    }
  };

  const results = await Promise.all(Array.from({ length: count }, one));
  const tally: BurstTally = { ok: 0, rejected: 0, degraded: 0, refused: 0, error: 0 };
  for (const r of results) tally[r]++;
  return tally;
}

// 이벤트를 종류에 맞는 핸들러로 넘긴다.
// switch로 좁혀서 넘기면 핸들러가 받는 인자 타입이 그 갈래로 확정된다.
// default의 never 할당이 핵심 — ChatEvent에 종류를 추가하고 여기 케이스를
// 빠뜨리면, event가 never가 아니게 되어 컴파일 에러가 난다.
function dispatch(event: ChatEvent, handlers: ChatHandlers): void {
  switch (event.type) {
    case "sources":
      handlers.sources?.(event);
      return;
    case "delta":
      handlers.delta?.(event);
      return;
    case "refusal":
      handlers.refusal?.(event);
      return;
    case "error":
      handlers.error?.(event);
      return;
    case "done":
      handlers.done?.(event);
      return;
    default: {
      const unhandled: never = event;
      console.warn("처리하지 않은 이벤트:", unhandled);
    }
  }
}

// SSE 응답을 읽어서 이벤트 타입별 핸들러를 호출한다.
// EventSource는 POST를 못 보내서 fetch로 직접 파싱한다.
//
// signal을 받는 이유: 사용자가 답변 도중 화면을 떠나거나 취소하면 읽기를
// 중단해야 한다. 안 그러면 죽은 컴포넌트를 향해 루프가 끝까지 돌고, 서버 쪽은
// 아무도 안 볼 답변을 만드느라 처리 슬롯을 계속 붙잡는다.
export async function streamChat(
  question: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
  // 질문에 첨부한 이미지. uploadChatImage로 먼저 올리고 받은 id를 싣는다 —
  // 바이트를 여기 실으면 같은 이미지로 질문을 고쳐 물을 때마다 2MB가 다시 간다.
  imageId?: string
): Promise<void> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(imageId ? { question, imageId } : { question }),
    signal,
  });
  checkSession(res);
  if (!res.ok) throw new Error(await errorMessage(res, "요청에 실패했습니다."));
  if (!res.body) throw new Error("스트림을 열 수 없습니다.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 이벤트는 빈 줄(\n\n)로 구분된다. 마지막 조각은 아직 미완성일 수 있어 남겨둔다.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      dispatch(JSON.parse(line.slice(5)) as ChatEvent, handlers);
    }
  }
}
