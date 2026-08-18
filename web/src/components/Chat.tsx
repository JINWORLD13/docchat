import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { MAX_IMAGE_BYTES, streamChat, uploadChatImage } from "../api";
import { readDimensions } from "../images";
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

// 보내기 전의 첨부 이미지. 실시간 채팅과 달리 고르는 즉시 보내지 않는다 —
// 여기서 이미지는 질문의 일부라, 질문 텍스트와 함께 가야 한다(카카오톡에서
// 사진에 설명을 붙여 보내는 것과 같은 흐름). 업로드도 보내기 순간에 한다.
// 고르자마자 올리면 마음을 바꿔 지운 첨부가 DB에 고아로 남는다.
interface Attachment {
  file: File;
  url: string; // 미리보기·말풍선 표시용 object URL. 원본이 이 브라우저에 있는데 서버에서 되받을 이유가 없다.
  width: number; // 원본 크기. 말풍선이 로드 전에 자리를 잡는 데 쓰고, 업로드에도 싣는다.
  height: number;
}

// 첨부를 받는 형식. 업로드(routes/images.ts)는 gif도 받지만 생성 모델이
// gif를 못 읽어서 질문에는 못 쓴다(routes/chat.ts). 서버가 어차피 거절할
// 파일을 2MB 올려보내고 나서 알리는 건 낭비라 파일 선택창에서부터 좁힌다.
const ACCEPT_MIMES = "image/png,image/jpeg,image/webp";

export default function Chat({ hasDocuments, active }: Props) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // 첨부 단계의 실패(너무 큼·못 읽는 파일). 대화에 남길 일이 아니라 배너로 알린다 —
  // 아직 아무것도 보내지 않았으므로 말풍선을 만들면 오히려 헷갈린다.
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  // 이미지를 첨부하는 유일한 경로. 파일 선택·붙여넣기·드래그앤드롭이 전부 여기로 온다.
  async function attach(file: File): Promise<void> {
    if (streaming) return;
    setAttachError(null);

    // 파일 선택창은 accept로 걸렀지만 붙여넣기·드래그는 그 필터를 안 거친다.
    // type은 브라우저가 적어주는 값이라 방어는 아니고(진짜 판별은 서버의
    // magic bytes), 2MB를 올려보내고 나서 거절당하는 낭비를 줄이는 용도다.
    if (file.type === "image/gif") {
      setAttachError("GIF는 질문에 쓸 수 없어요. PNG·JPG·WebP로 올려주세요.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setAttachError("이미지는 2MB 이하만 올릴 수 있어요.");
      return;
    }

    try {
      const { width, height } = await readDimensions(file);
      // 바꿔치기한 경우, 이전 미리보기 URL은 이제 아무도 안 본다.
      // (보낸 메시지가 들고 있는 URL은 여기 오지 않는다 — 보낼 때 attachment를
      //  비우므로, 이 시점의 attachment는 언제나 안 보낸 첨부다)
      if (attachment) URL.revokeObjectURL(attachment.url);
      setAttachment({ file, url: URL.createObjectURL(file), width, height });
    } catch {
      setAttachError("브라우저가 읽을 수 없는 이미지예요.");
    }
  }

  function removeAttachment(): void {
    if (attachment) URL.revokeObjectURL(attachment.url);
    setAttachment(null);
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일을 다시 골라도 change가 오도록 비워둔다
    if (file) void attach(file);
  }

  // 스크린샷을 찍어 바로 붙여넣는 경우. 문서 Q&A에서 제일 흔할 첨부 방식이다
  // (오류 화면을 찍어 "이거 왜 이래요"라고 묻는 흐름).
  function handlePaste(e: ClipboardEvent<HTMLInputElement>): void {
    const file = [...e.clipboardData.files][0];
    if (file) {
      e.preventDefault(); // 파일명이 텍스트로 입력창에 들어가지 않게
      void attach(file);
    }
  }

  function handleDrop(e: DragEvent): void {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files][0];
    if (file) void attach(file);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;

    // state는 바로 아래에서 비우므로 이번 전송분을 지역 변수로 붙잡아둔다.
    const attached = attachment;

    setInput("");
    setAttachment(null); // object URL은 revoke하지 않는다 — 방금 만든 말풍선이 계속 쓴다
    setAttachError(null);
    setStreaming(true);
    const ts = Date.now();
    setMessages((prev) => [
      ...prev,
      attached
        ? {
            role: "user",
            content: question,
            ts,
            image: { url: attached.url, width: attached.width, height: attached.height },
          }
        : { role: "user", content: question, ts },
      { role: "assistant", content: "", ts },
    ]);
    // 내가 방금 보낸 질문은 위쪽을 읽고 있었더라도 보여준다. 여기서 다시
    // 붙여두면 이어지는 답변도 자연스럽게 따라간다.
    stickRef.current = true;
    scrollToBottom();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 이미지는 보내는 순간에 올리고, 받은 id를 질문에 실어 보낸다.
      // 업로드가 끝나기 전에 질문부터 가면 서버가 아직 없는 이미지를 가리키게
      // 된다 (realtime/Room.tsx의 sendImage와 같은 순서).
      let imageId: string | undefined;
      if (attached) {
        const { id } = await uploadChatImage(attached.file, attached.width, attached.height);
        imageId = id;
      }

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
        controller.signal,
        imageId
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
    <main
      className={"chat" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        e.preventDefault(); // 이걸 막지 않으면 브라우저가 파일을 열어버린다
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {/* 봇과의 1:1 채팅방처럼 보이게 하는 상단 바. 대화 상대(봇)의 정체를
          여기서 한 번 보여주면, 아래 말풍선들이 "누구와의 대화"인지 잡힌다. */}
      <header className="chat-head">
        <div className="avatar" aria-hidden>
          💬
        </div>
        <div className="chat-head-text">
          <div className="chat-head-name">DocChat</div>
          <div className="chat-head-sub">
            {hasDocuments ? "업로드한 문서를 근거로 답하는 봇" : "문서를 올리면 그걸로 답해요"}
          </div>
        </div>
      </header>

      <div className="messages" ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {hasDocuments
              ? "업로드한 문서에 대해 질문해보세요. 이미지를 붙여 물어볼 수도 있어요."
              : "왼쪽에서 문서(txt, md)를 먼저 업로드해주세요. 이미지 질문은 문서 없이도 돼요."}
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
      </div>

      {dragging && <div className="drop-hint">여기에 놓으면 질문에 이미지를 첨부합니다</div>}

      {attachError && (
        <div className="chat-error" onClick={() => setAttachError(null)}>
          {attachError}
        </div>
      )}

      {/* 보내기 전의 첨부 미리보기. 여기 보이는 건 아직 아무 데도 안 간 파일이라
          ×로 지우면 흔적 없이 사라진다(업로드는 보내기 순간에 하므로). */}
      {attachment && (
        <div className="attach-preview">
          <img src={attachment.url} alt="첨부할 이미지 미리보기" />
          <span className="attach-name">{attachment.file.name}</span>
          <button
            type="button"
            className="attach-remove"
            onClick={removeAttachment}
            title="첨부 취소"
            aria-label="첨부 취소"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}

      <form className="input-bar" onSubmit={(e) => void handleSubmit(e)}>
        <button
          type="button"
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={streaming}
          title="이미지 첨부 (붙여넣기·끌어놓기도 됩니다)"
          aria-label="이미지 첨부"
        >
          {/* 글자 대신 svg를 쓰는 이유는 realtime 쪽 attach 버튼과 같다
              (index.css의 .send-bar .attach 주석) */}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M8 3.25v9.5M3.25 8h9.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <input type="file" ref={fileRef} accept={ACCEPT_MIMES} onChange={handleFilePick} hidden />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          placeholder={attachment ? "첨부한 이미지에 대해 질문하기" : "문서 내용에 대해 질문하기"}
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
