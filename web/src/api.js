const BASE = "/api";

export async function fetchDocuments() {
  const res = await fetch(`${BASE}/documents`);
  if (!res.ok) throw new Error("문서 목록을 불러오지 못했습니다.");
  return res.json();
}

export async function uploadDocument(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/documents`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "업로드에 실패했습니다.");
  return data;
}

export async function fetchDocument(id) {
  const res = await fetch(`${BASE}/documents/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "문서를 불러오지 못했습니다.");
  return data;
}

export async function updateDocument(id, content) {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "수정에 실패했습니다.");
  return data;
}

export async function deleteDocument(id) {
  const res = await fetch(`${BASE}/documents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("삭제에 실패했습니다.");
}

// --- 대시보드(부하·장애 대응 시연) ---

export async function fetchMetrics() {
  const res = await fetch(`${BASE}/metrics`);
  if (!res.ok) throw new Error("metrics 실패");
  return res.json();
}

// LLM 장애 주입 on/off
export async function setFault(llmFail) {
  await fetch(`${BASE}/admin/fault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llmFail }),
  });
}

// 회로·장애 상태 초기화
export async function resetDefense() {
  await fetch(`${BASE}/admin/reset`, { method: "POST" });
}

// 동시 count개의 질문을 쏴서(트래픽 폭주 흉내) 상태별로 집계한다.
export async function burst(count, question = "환불은 며칠 걸려?") {
  const one = async () => {
    try {
      const res = await fetch(`${BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (res.status === 429) {
        await res.text().catch(() => {});
        return "rejected";
      }
      const text = await res.text().catch(() => "");
      if (text.includes("답변 생성이 어려워")) return "degraded";
      if (text.includes("관련 내용을 찾지 못했")) return "refused";
      return "ok";
    } catch {
      return "error";
    }
  };
  const results = await Promise.all(Array.from({ length: count }, one));
  const tally = { ok: 0, rejected: 0, degraded: 0, refused: 0, error: 0 };
  for (const r of results) tally[r]++;
  return tally;
}

// SSE 응답을 읽어서 이벤트 타입별 핸들러를 호출한다.
// EventSource는 POST를 못 보내서 fetch로 직접 파싱한다.
export async function streamChat(question, handlers) {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "요청에 실패했습니다.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 이벤트는 빈 줄(\n\n)로 구분된다. 마지막 조각은 아직 미완성일 수 있어 남겨둔다.
    const parts = buffer.split("\n\n");
    buffer = parts.pop();

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5));
      handlers[event.type]?.(event);
    }
  }
}
