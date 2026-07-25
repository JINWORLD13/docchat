import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { socket } from "./socket";
import { MAX_IMAGE_BYTES, uploadChatImage } from "../api";
import type { ChatMessage } from "./types";

interface Props {
  nickname: string;
  room: string;
  error: string | null;
  onDismissError: () => void;
  onLeave: () => void;
}

// 화면에 쌓이는 항목: 실제 메시지 또는 입장/퇴장 같은 시스템 알림
type Item =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "system"; id: string; text: string };

// 이미지의 원본 크기를 미리 재둔다.
// 이 값이 있어야 <img>가 뜨기 전에 자리를 잡아, 사진이 로드될 때 위의 대화가
// 아래로 밀리지 않는다. 여기서 실패하면 브라우저가 못 읽는 파일이라는 뜻이라
// 업로드까지 가지 않고 바로 알려준다.
async function readDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

// 대화창.
// 소켓 연결 자체는 LiveChat이 관리한다. 여기는 "이 방에 관한 이벤트"만 구독한다.
export default function Room({ nickname, room, error, onDismissError, onLeave }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // 핸들러를 변수에 담아두고 off에 그대로 넘긴다.
    // socket.off("message")처럼 이름만 주면 그 이벤트의 리스너를 전부 지운다.
    // 지금은 LiveChat도 소켓을 듣고 있어서, 그렇게 하면 남의 구독까지 날아간다.
    const onHistory = (msgs: ChatMessage[]) => {
      setItems(msgs.map((msg) => ({ kind: "msg", msg })));
    };
    const onMessage = (msg: ChatMessage) => {
      setItems((prev) => [...prev, { kind: "msg", msg }]);
    };
    const onSystem = (text: string) => {
      setItems((prev) => {
        // 연속으로 같은 시스템 알림(입장/퇴장)이 오면 하나만 보여준다.
        // (개발 모드 StrictMode 이중 실행 등으로 중복될 때 대비)
        const last = prev[prev.length - 1];
        if (last && last.kind === "system" && last.text === text) return prev;
        return [...prev, { kind: "system", id: crypto.randomUUID(), text }];
      });
    };
    const onPresence = (list: string[]) => setUsers(list);
    const onTyping = (who: string) => {
      setTypingUser(who);
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setTypingUser(null), 1500);
    };

    socket.on("history", onHistory);
    socket.on("message", onMessage);
    socket.on("system", onSystem);
    socket.on("presence", onPresence);
    socket.on("typing", onTyping);

    // 구독을 먼저 걸고 입장을 알린다 — 순서가 반대면 서버가 즉시 돌려주는
    // history를 놓칠 수 있다.
    socket.emit("join", { room });

    return () => {
      socket.off("history", onHistory);
      socket.off("message", onMessage);
      socket.off("system", onSystem);
      socket.off("presence", onPresence);
      socket.off("typing", onTyping);
      window.clearTimeout(typingTimer.current);
    };
  }, [room]);

  // 새 항목이 오면 맨 아래로 스크롤
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, typingUser]);

  function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    socket.emit("message", { text });
    setInput("");
  }

  function handleChange(value: string) {
    setInput(value);
    socket.emit("typing"); // 내가 입력 중이라고 방에 알림
  }

  // 이미지를 보내는 유일한 경로. 파일 선택·붙여넣기·드래그앤드롭이 전부 여기로 온다.
  async function sendImage(file: File): Promise<void> {
    if (uploading) return;
    setUploadError(null);

    // 서버도 검사하지만, 2MB짜리를 다 올려보내고 나서 거절당하는 건 낭비다.
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError("이미지는 2MB 이하만 올릴 수 있어요.");
      return;
    }

    setUploading(true);
    try {
      const { width, height } = await readDimensions(file);
      const { id } = await uploadChatImage(file, width, height);
      // 업로드가 끝나야 방에 알린다. 반대 순서면 아직 없는 이미지를 가리키게 된다.
      socket.emit("image", { imageId: id });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "이미지를 보내지 못했어요.");
    } finally {
      setUploading(false);
    }
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일을 다시 골라도 change가 오도록 비워둔다
    if (file) void sendImage(file);
  }

  // 스크린샷을 찍어 바로 붙여넣는 경우. 채팅에서 제일 흔한 이미지 전송 방식이다.
  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const file = [...e.clipboardData.files][0];
    if (file) {
      e.preventDefault(); // 파일명이 텍스트로 입력창에 들어가지 않게
      void sendImage(file);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files][0];
    if (file) void sendImage(file);
  }

  const banner = uploadError ?? error;

  return (
    <div
      className={"chatroom" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        e.preventDefault(); // 이걸 막지 않으면 브라우저가 파일을 열어버린다
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <header className="room-head">
        <div className="room-title">
          <span className="room-name">#{room}</span>
          <span className="room-me"> · {nickname}</span>
        </div>
        <button className="leave" onClick={onLeave}>
          방 나가기
        </button>
      </header>

      <div className="room-body">
        <div className="messages" ref={listRef}>
          {items.length === 0 && (
            <div className="room-quiet">아직 대화가 없어요. 먼저 말을 걸어보세요.</div>
          )}
          {items.map((it) =>
            it.kind === "system" ? (
              <div key={it.id} className="system">
                {it.text}
              </div>
            ) : (
              <Bubble key={it.msg.id} msg={it.msg} mine={it.msg.nickname === nickname} />
            )
          )}
          {typingUser && typingUser !== nickname && (
            <div className="typing">{typingUser} 님이 입력 중…</div>
          )}
        </div>

        <aside className="users">
          <div className="users-title">접속 중 {users.length}</div>
          {users.map((u, i) => (
            <div key={i} className={"user" + (u === nickname ? " me" : "")}>
              {u}
            </div>
          ))}
        </aside>
      </div>

      {dragging && <div className="drop-hint">여기에 놓으면 이미지를 보냅니다</div>}

      {banner && (
        <div
          className="chat-error"
          onClick={() => {
            setUploadError(null);
            onDismissError();
          }}
        >
          {banner}
        </div>
      )}

      <form className="send-bar" onSubmit={send}>
        <button
          type="button"
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="이미지 보내기 (붙여넣기·끌어놓기도 됩니다)"
          aria-label="이미지 보내기"
        >
          {uploading ? "…" : "＋"}
        </button>
        <input
          type="file"
          ref={fileRef}
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={handleFilePick}
          hidden
        />
        <input
          value={input}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={handlePaste}
          placeholder={uploading ? "이미지 올리는 중…" : `#${room} 에 메시지 보내기`}
          maxLength={500}
          autoFocus
        />
        <button type="submit" disabled={!input.trim()}>
          보내기
        </button>
      </form>
    </div>
  );
}

// 말풍선에 넣을 이미지의 표시 크기.
//
// CSS만으로 width:100% / height:auto 를 주면 안 된다. 부모가 내용에 맞춰
// 줄어드는(shrink-to-fit) 상자라 100%의 기준이 결국 이미지의 원본 픽셀 크기가
// 되고, 넘겨준 width/height는 무시된다. 그러면 작은 이미지는 아주 작게 나오고,
// 무엇보다 로드되기 전에는 상자 크기를 모르니 자리를 못 잡아 대화가 밀린다.
// 그래서 표시 크기를 여기서 직접 계산해 상자에 박아둔다.
const MAX_W = 320;
const MAX_H = 360;
const MIN_SIDE = 48; // 아주 작은 이미지도 눌러볼 수 있을 만큼은 보이게

function displaySize(width: number, height: number): { width: number; height: number } {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const scale = Math.min(MAX_W / safeW, MAX_H / safeH, 1); // 원본보다 키우지는 않는다
  return {
    width: Math.max(MIN_SIDE, Math.round(safeW * scale)),
    height: Math.max(MIN_SIDE, Math.round(safeH * scale)),
  };
}

function Bubble({ msg, mine }: { msg: ChatMessage; mine: boolean }) {
  const time = new Date(msg.ts).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={"bubble-row" + (mine ? " mine" : "")}>
      {!mine && <div className="bubble-nick">{msg.nickname}</div>}
      {msg.kind === "image" ? (
        <div className="image-wrap">
          {/* 크기를 미리 박아두면 이미지가 도착하기 전에도 자리가 잡힌다 */}
          <a
            className="bubble-image"
            href={msg.url}
            target="_blank"
            rel="noreferrer"
            style={displaySize(msg.width, msg.height)}
          >
            <img src={msg.url} loading="lazy" alt={`${msg.nickname} 님이 보낸 이미지`} />
          </a>
          <span className="bubble-time">{time}</span>
        </div>
      ) : (
        <div className="bubble">
          <span className="bubble-text">{msg.text}</span>
          <span className="bubble-time">{time}</span>
        </div>
      )}
    </div>
  );
}
