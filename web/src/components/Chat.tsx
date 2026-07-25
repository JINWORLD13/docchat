import { useRef, useState, type FormEvent } from "react";
import { streamChat } from "../api";
import Message, { type AssistantMessage, type ChatItem } from "./Message";

export default function Chat({ hasDocuments }: { hasDocuments: boolean }) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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

    try {
      await streamChat(question, {
        sources: (e) => patchLast((m) => ({ ...m, sources: e.sources })),
        delta: (e) => {
          patchLast((m) => ({ ...m, content: m.content + e.text }));
          scrollToBottom();
        },
        refusal: (e) => patchLast((m) => ({ ...m, content: e.message, refused: true })),
        done: (e) => patchLast((m) => ({ ...m, usage: e.usage })),
        error: (e) => patchLast((m) => ({ ...m, content: e.message, error: true })),
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : "요청에 실패했습니다.";
      patchLast((m) => ({ ...m, content: text, error: true }));
    } finally {
      setStreaming(false);
      scrollToBottom();
    }
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
        <button type="submit" disabled={streaming || !input.trim()}>
          {streaming ? "답변 중..." : "보내기"}
        </button>
      </form>
    </main>
  );
}
