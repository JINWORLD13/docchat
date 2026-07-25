import { useEffect, useRef, useState, type FormEvent } from "react";
import { streamChat } from "../api";
import Message, { type AssistantMessage, type ChatItem } from "./Message";

export default function Chat({ hasDocuments }: { hasDocuments: boolean }) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // 진행 중인 요청을 중단하기 위한 손잡이.
  // 답변은 몇 초씩 걸리므로 그 사이에 화면을 떠나는 일이 흔하다. 그때
  // 끊어주지 않으면 이미 사라진 컴포넌트를 향해 읽기 루프가 끝까지 돌고,
  // 서버는 아무도 안 볼 답변을 만드느라 처리 슬롯 하나를 계속 붙잡는다.
  const abortRef = useRef<AbortController | null>(null);

  // 화면을 떠나면 진행 중인 답변을 끊는다.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 항상 마지막 메시지(스트리밍 중인 답변)를 갱신한다.
  // 마지막이 assistant일 때만 손대도록 좁혀둔다 — JS일 땐 이 가정이 주석으로만
  // 있었고, 어긋나면 user 메시지에 sources를 붙이는 이상한 상태가 될 수 있었다.
  function patchLast(updater: (m: AssistantMessage) => AssistantMessage): void {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), updater(last)];
    });
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;

    setInput("");
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);
    scrollToBottom();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        question,
        {
          sources: (e) => patchLast((m) => ({ ...m, sources: e.sources })),
          delta: (e) => {
            patchLast((m) => ({ ...m, content: m.content + e.text }));
            scrollToBottom();
          },
          refusal: (e) => patchLast((m) => ({ ...m, content: e.message, refused: true })),
          done: (e) => patchLast((m) => ({ ...m, usage: e.usage })),
          error: (e) => patchLast((m) => ({ ...m, content: e.message, error: true })),
        },
        controller.signal
      );
    } catch (err) {
      // 내가 끊은 것은 오류가 아니다. 취소했다고 빨간 메시지를 남기지 않는다.
      if (!controller.signal.aborted) {
        const text = err instanceof Error ? err.message : "요청에 실패했습니다.";
        patchLast((m) => ({ ...m, content: text, error: true }));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      scrollToBottom();
    }
  }

  // 답변을 기다리다 그만두고 싶을 때. 이게 없으면 상류(LLM)가 멈췄을 때
  // streaming이 영영 true로 남아, 입력창이 잠긴 채 새로고침 말고는 길이 없다.
  function cancel(): void {
    abortRef.current?.abort();
    patchLast((m) => ({ ...m, content: m.content || "답변을 취소했어요.", refused: true }));
  }

  return (
    <main className="chat">
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {hasDocuments
              ? "업로드한 문서에 대해 질문해보세요."
              : "왼쪽에서 문서(txt, md)를 먼저 업로드해주세요."}
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
      </div>

      <form className="input-bar" onSubmit={(e) => void handleSubmit(e)}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="문서 내용에 대해 질문하기"
          maxLength={500}
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" onClick={cancel}>
            취소
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            보내기
          </button>
        )}
      </form>
    </main>
  );
}
