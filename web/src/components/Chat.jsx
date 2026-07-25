import { useRef, useState } from "react";
import { streamChat } from "../api.js";
import Message from "./Message.jsx";

export default function Chat({ hasDocuments }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef(null);

  // 항상 마지막 메시지(스트리밍 중인 답변)를 갱신한다
  function patchLast(updater) {
    setMessages((prev) => {
      const next = prev.slice();
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function handleSubmit(e) {
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
      patchLast((m) => ({ ...m, content: err.message, error: true }));
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

      <form className="input-bar" onSubmit={handleSubmit}>
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
