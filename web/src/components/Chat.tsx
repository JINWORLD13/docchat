import { useEffect, useRef, useState, type FormEvent } from "react";
import { streamChat } from "../api";
import Message, { type AssistantMessage, type ChatItem } from "./Message";

// 바닥에서 이만큼 안이면 "아직 끝을 보고 있다"로 친다.
// 0으로 두면 서브픽셀 반올림(브라우저 확대, 고배율 디스플레이)만으로도
// 몇 px이 남아 붙어 있기를 놓친다.
const NEAR_BOTTOM_PX = 80;

interface Props {
  hasDocuments: boolean;
  // 지금 보이는 탭인지. 이 화면은 언마운트되지 않고 숨겨지기만 하므로
  // (App.tsx 참고) 다시 보이는 순간을 스스로 알 방법이 이것뿐이다.
  active: boolean;
}

export default function Chat({ hasDocuments, active }: Props) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // 진행 중인 요청을 중단하기 위한 손잡이.
  // 답변은 몇 초씩 걸리므로 그 사이에 화면을 떠나는 일이 흔하다. 그때
  // 끊어주지 않으면 이미 사라진 컴포넌트를 향해 읽기 루프가 끝까지 돌고,
  // 서버는 아무도 안 볼 답변을 만드느라 처리 슬롯 하나를 계속 붙잡는다.
  const abortRef = useRef<AbortController | null>(null);
  // 새 글자가 올 때 바닥으로 따라 내려갈지.
  // 예전엔 델타마다 무조건 끌어내렸다. 그래서 답변이 나오는 동안에는 앞선
  // 대화를 다시 읽을 수가 없었다 — 올리는 족족 다음 조각이 도착해 도로
  // 내려갔다. 사용자가 이미 바닥 근처일 때만 따라간다.
  const stickRef = useRef(true);
  // 숨겨졌다 돌아왔을 때 되돌릴 자리. 아래 active effect에서만 쓴다.
  const savedTopRef = useRef(0);
  // 직전 scrollTop. 이번 이동이 위로 간 것인지 아래로 간 것인지 판단하는 데 쓴다
  // (handleScroll 주석 참고).
  const prevTopRef = useRef(0);

  // 화면을 떠나면 진행 중인 답변을 끊는다.
  // 탭 전환으로는 이 정리 함수가 돌지 않는다(숨겨질 뿐 언마운트가 아니다) —
  // 그게 이 화면을 숨겨서 살려두는 이유다.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 숨어 있는 동안에는 scrollHeight도 clientHeight도 0이라 scrollToBottom이
  // 아무 일도 하지 못하고, 브라우저는 레이아웃 상자를 버리면서 scrollTop까지
  // 0으로 되돌린다. 그래서 다시 보이는 순간 한 번 직접 맞춰준다 —
  // 따라가던 중이었으면 맨 아래로(그 사이 쌓인 답변이 보이게),
  // 위를 읽던 중이었으면 읽던 자리로.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = stickRef.current ? el.scrollHeight : savedTopRef.current;
      prevTopRef.current = el.scrollTop;
    });
  }, [active]);

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

  // 여기 들어오는 이동에는 사용자가 굴린 것과 scrollToBottom이 만든 것이 섞여 있다.
  // 그래서 "지금 바닥 근처인가"만 보고 stick을 정하면 안 된다 — scroll 이벤트는
  // 즉시가 아니라 다음 렌더 시점에 전달되는데, 그 사이 다음 조각이 도착해 내용이
  // 이미 더 길어져 있다. 그러면 방금 바닥으로 내려놓고서도 "바닥에서 멀다"는
  // 측정값이 나와 스스로 붙어있기를 놓아버린다 (붙잡기 전에 실제로 겪은 버그다).
  //
  // 그래서 떼어낼지는 '위로 올라간 이동'에서만 판단한다. scrollToBottom이 만드는
  // 이동은 언제나 아래쪽이라 이 문을 통과하지 못한다.
  function handleScroll(): void {
    const el = listRef.current;
    // 숨겨져 있는 동안 들어온 이벤트는 버린다. 그때는 높이가 전부 0이라
    // 무엇을 재도 "바닥에 붙어 있다"로 읽혀서, 위를 읽던 자리를 잃는다.
    if (!el || el.clientHeight === 0) return;
    const top = el.scrollTop;
    const nearBottom = el.scrollHeight - top - el.clientHeight <= NEAR_BOTTOM_PX;
    if (top < prevTopRef.current) {
      // 위로 올렸다. 다만 몇 px짜리 손떨림까지 떼어내면 성가시므로 문턱을 둔다.
      stickRef.current = nearBottom;
    } else if (nearBottom) {
      // 다시 바닥까지 내려왔다 — 따라가기를 재개한다.
      stickRef.current = true;
    }
    prevTopRef.current = top;
    savedTopRef.current = top;
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
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
    // 내가 방금 보낸 질문은 위쪽을 읽고 있었더라도 보여준다. 여기서 다시
    // 붙여두면 이어지는 답변도 자연스럽게 따라간다.
    stickRef.current = true;
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
      <div className="messages" ref={listRef} onScroll={handleScroll}>
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
