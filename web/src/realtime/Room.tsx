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
import { displaySize, readDimensions } from "../images";
import type { ChatMessage } from "./types";

interface Props {
  nickname: string;
  // 내 공개 신원. "내 메시지"(취소 버튼) 판단의 근거다 — 닉네임으로 판단하면
  // 같은 이름을 쓴 사람의 메시지까지 내 것으로 보인다.
  authorId: string | null;
  room: string;
  connected: boolean;
  error: string | null;
  onDismissError: () => void;
  onLeave: () => void;
}

// 화면에 쌓이는 항목: 실제 메시지 또는 입장/퇴장 같은 시스템 알림
type Item =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "system"; id: string; text: string };

// 시스템 알림에 붙일 로컬 id.
//
// crypto.randomUUID는 보안 컨텍스트(HTTPS 또는 localhost)에서만 존재한다.
// http://<ip>:5173 같은 데모 주소로 열면 아예 함수가 없어서, 첫 입장 알림에서
// setItems 안이 터지고 React가 화면 전체를 내려버린다. 개발 머신에서는 멀쩡한데
// 배포 주소에서만 죽는 종류라, 대비해 둔다.
let localSeq = 0;
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  localSeq += 1;
  return `sys-${Date.now()}-${localSeq}`;
}

// 대화창.
// 소켓 연결 자체는 LiveChat이 관리한다. 여기는 "이 방에 관한 이벤트"만 구독한다.
export default function Room({
  nickname,
  authorId,
  room,
  connected,
  error,
  onDismissError,
  onLeave,
}: Props) {
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
  // 마지막으로 "입력 중"을 보낸 시각 (handleChange에서 묶어 보내기 위해)
  const lastTypingSent = useRef(0);

  useEffect(() => {
    // 핸들러를 변수에 담아두고 off에 그대로 넘긴다.
    // socket.off("message")처럼 이름만 주면 그 이벤트의 리스너를 전부 지운다.
    // 지금은 LiveChat도 소켓을 듣고 있어서, 그렇게 하면 남의 구독까지 날아간다.
    const onHistory = (msgs: ChatMessage[]) => {
      setItems((prev) => {
        if (prev.length === 0) return msgs.map((msg) => ({ kind: "msg", msg }));

        // 재연결로 기록을 다시 받은 경우. 통째로 갈아끼우면 그동안 쌓인 시스템
        // 알림이 사라지고, 대화가 서버 보관 상한(50개)을 넘겼으면 앞부분이
        // 눈앞에서 잘려나간다. 이미 가진 메시지는 두고 처음 보는 것만 붙인다.
        const seen = new Set<string>();
        for (const it of prev) if (it.kind === "msg") seen.add(it.msg.id);

        const fresh: Item[] = msgs
          .filter((msg) => !seen.has(msg.id))
          .map((msg) => ({ kind: "msg", msg }));

        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    };
    const onMessage = (msg: ChatMessage) => {
      setItems((prev) => [...prev, { kind: "msg", msg }]);
    };
    // 누군가 자기 메시지를 취소했다. 시스템 알림은 남기지 않는다 —
    // "○○ 님이 메시지를 삭제했습니다"는 지운 사실 자체를 다시 알리는 셈이다.
    const onDeleted = (id: string) => {
      setItems((prev) => prev.filter((it) => it.kind !== "msg" || it.msg.id !== id));
    };
    const onSystem = (text: string) => {
      setItems((prev) => {
        // 연속으로 같은 시스템 알림(입장/퇴장)이 오면 하나만 보여준다.
        // (개발 모드 StrictMode 이중 실행 등으로 중복될 때 대비)
        const last = prev[prev.length - 1];
        if (last && last.kind === "system" && last.text === text) return prev;
        return [...prev, { kind: "system", id: newId(), text }];
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
    socket.on("messageDeleted", onDeleted);
    socket.on("system", onSystem);
    socket.on("presence", onPresence);
    socket.on("typing", onTyping);

    // 구독을 먼저 걸고 입장을 알린다 — 순서가 반대면 서버가 즉시 돌려주는
    // history를 놓칠 수 있다.
    //
    // 연결돼 있을 때만 보낸다. 끊긴 동안 emit하면 socket.io가 버퍼에 담았다가
    // 재연결 순간 먼저 흘려보내는데, 그러면 LiveChat이 보내는 hello보다 join이
    // 앞질러 나가 "먼저 닉네임을 정해주세요"로 거절당한다.
    // 끊긴 상태에서의 재입장은 LiveChat의 connect 핸들러가 책임진다.
    if (socket.connected) socket.emit("join", { room });

    return () => {
      socket.off("history", onHistory);
      socket.off("message", onMessage);
      socket.off("messageDeleted", onDeleted);
      socket.off("system", onSystem);
      socket.off("presence", onPresence);
      socket.off("typing", onTyping);
      window.clearTimeout(typingTimer.current);
    };
  }, [room]);

  // 새 항목이 오면 맨 아래로 스크롤 — 단, 이미 아래를 보고 있을 때만.
  //
  // 예전엔 조건 없이 끌어내렸다. typingUser는 상대가 글자를 칠 때마다 바뀌므로,
  // 방에 누가 타자를 치고 있으면 위로 올려 기록을 읽는 것 자체가 불가능했다.
  // 스크롤 위치는 사용자의 의도다 — 아래에 붙어 있으면 따라가고, 올려서 뭔가를
  // 읽는 중이면 건드리지 않는다.
  const stickToBottom = useRef(true);
  const prevTop = useRef(0);

  // 떼어낼지는 '위로 올라간 이동'에서만 판단한다.
  //
  // "지금 바닥 근처인가"만 보면 안 된다. scroll 이벤트는 즉시가 아니라 나중에
  // 전달되는데, 그 사이 새 메시지가 도착해 내용이 이미 더 길어져 있을 수 있다.
  // 그러면 방금 우리가 바닥으로 내려놓고서도 "바닥에서 멀다"는 측정값이 나와
  // 스스로 따라가기를 놓아버린다. 우리가 만드는 이동은 언제나 아래쪽이므로,
  // 위로 간 경우에만 판단하면 그 오검출이 통과하지 못한다.
  // (문서 Q&A 쪽 Chat.tsx도 같은 이유로 같은 방식을 쓴다)
  const handleScroll = () => {
    const el = listRef.current;
    if (!el || el.clientHeight === 0) return;
    const top = el.scrollTop;
    const nearBottom = el.scrollHeight - top - el.clientHeight <= 80;
    if (top < prevTop.current) stickToBottom.current = nearBottom;
    else if (nearBottom) stickToBottom.current = true;
    prevTop.current = top;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
      prevTop.current = el.scrollTop;
    }
  }, [items, typingUser]);

  function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    // 끊긴 상태에서는 보내지 않는다.
    //
    // 그냥 emit하면 socket.io가 버퍼에 담아뒀다가 재연결 직후 흘려보내는데,
    // 그 시점의 서버 소켓은 아직 hello를 못 받아 닉네임도 방도 없다. 서버는
    // 그 메시지를 조용히 버리고, 화면에는 입력창이 비워진 것만 남는다 —
    // 보낸 줄 알았던 말이 아무 데도 없는 상태가 된다.
    // 버리더라도 입력한 글은 남겨서 다시 보낼 수 있게 한다.
    if (!connected) {
      setUploadError("연결이 끊겨 있어요. 다시 연결되면 보내주세요.");
      return;
    }

    socket.emit("message", { text });
    setInput("");
  }

  // 보낸 것 취소. 서버가 작성자를 다시 확인하므로(권한은 서버가 판단한다)
  // 여기서 보내는 건 id뿐이고, 화면에서 지우는 것도 서버가 알려줄 때 한다 —
  // 미리 지워두면 거절당했을 때 되살려야 한다.
  function cancelMessage(msg: ChatMessage) {
    const what = msg.kind === "image" ? "이 이미지를" : "이 메시지를";
    if (!confirm(`${what} 취소할까요? 방에 있는 모두에게서 사라져요.`)) return;
    socket.emit("deleteMessage", { messageId: msg.id });
  }

  function handleChange(value: string) {
    setInput(value);

    // 입력 중 알림은 초당 한 번으로 묶는다.
    //
    // 글자마다 보내면 방 인원수만큼 곱해져 나가는 것도 문제지만, 더 큰 문제는
    // 서버의 동작 버킷(join·방 삭제·취소와 공용, 초당 10개)을 타자만으로 비운다는
    // 것이다. 그 버킷이 비면 다음에 누른 "방 삭제"나 "취소"가 조용히 무시된다 —
    // 확인 창까지 눌렀는데 아무 일도 안 일어난다.
    // 어차피 상대 화면에서는 1.5초간 유지되는 표시라 초당 한 번이면 충분하다.
    const now = Date.now();
    if (now - lastTypingSent.current < 1000) return;
    lastTypingSent.current = now;
    socket.emit("typing");
  }

  // 이미지를 보내는 유일한 경로. 파일 선택·붙여넣기·드래그앤드롭이 전부 여기로 온다.
  async function sendImage(file: File): Promise<void> {
    if (uploading) return;
    setUploadError(null);

    // 텍스트와 같은 이유(send 참고). 여기서는 더 아깝다 — 업로드까지 끝낸 뒤
    // 소켓 메시지만 버려지면, DB에는 아무도 못 보는 이미지가 남는다.
    if (!connected) {
      setUploadError("연결이 끊겨 있어요. 다시 연결되면 보내주세요.");
      return;
    }

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

  // 닉네임이 아니라 authorId로 비교한다. 닉네임은 아무나 같은 값을 쓸 수 있어서,
  // 예전에는 나와 이름이 같은 사람의 메시지가 내 것으로 보이고 취소 버튼까지
  // 붙었다(서버가 막아주긴 했다). 보이는 이름과 권한의 근거를 분리한 결과다.
  const isMine = (msg: ChatMessage): boolean =>
    authorId !== null && msg.authorId === authorId;

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
        <div className="messages" ref={listRef} onScroll={handleScroll}>
          {items.length === 0 && (
            <div className="room-quiet">아직 대화가 없어요. 먼저 말을 걸어보세요.</div>
          )}
          {items.map((it) =>
            it.kind === "system" ? (
              <div key={it.id} className="system">
                {it.text}
              </div>
            ) : (
              <Bubble
                key={it.msg.id}
                msg={it.msg}
                mine={isMine(it.msg)}
                // 취소 버튼은 내 것에만 붙인다. 남의 메시지에 달아도 서버가
                // 거절하지만, 눌러서 거절당할 버튼을 보여줄 이유가 없다.
                onCancel={isMine(it.msg) ? () => cancelMessage(it.msg) : undefined}
              />
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
          className={"attach" + (uploading ? " busy" : "")}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={uploading ? "이미지 올리는 중…" : "이미지 보내기 (붙여넣기·끌어놓기도 됩니다)"}
          aria-label={uploading ? "이미지 올리는 중" : "이미지 보내기"}
        >
          {/* 글자 대신 svg. 폰트에 따라 글자가 상자 안에서 치우치는 걸 피한다
              (index.css의 .send-bar .attach 주석). 올리는 동안에는 같은
              아이콘을 깜빡여서 상자 크기가 흔들리지 않게 한다. */}
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

// 말풍선에 넣을 이미지의 표시 크기 계산(displaySize)은 ../images.ts에 있다 —
// 문서 Q&A의 첨부 이미지와 같은 계산을 쓴다.

function Bubble({
  msg,
  mine,
  onCancel,
}: {
  msg: ChatMessage;
  mine: boolean;
  onCancel?: () => void;
}) {
  const time = new Date(msg.ts).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const body =
    msg.kind === "image" ? (
      // 크기를 미리 박아두면 이미지가 도착하기 전에도 자리가 잡힌다
      <a
        className="bubble-image"
        href={msg.url}
        target="_blank"
        rel="noreferrer"
        style={displaySize(msg.width, msg.height)}
      >
        <img src={msg.url} loading="lazy" alt={`${msg.nickname} 님이 보낸 이미지`} />
      </a>
    ) : (
      <div className="bubble">
        <span className="bubble-text">{msg.text}</span>
      </div>
    );

  return (
    <div className={"bubble-row" + (mine ? " mine" : "")}>
      {/* 상대에게만 아바타를 붙인다 — 카카오톡처럼 내 쪽에는 없다.
          프로필 사진이 없으니 닉네임 첫 글자가 얼굴 노릇을 한다. */}
      {!mine && (
        <div className="avatar" aria-hidden>
          {msg.nickname.slice(0, 1)}
        </div>
      )}
      <div className="bubble-col">
        {!mine && <div className="bubble-nick">{msg.nickname}</div>}
        {/* 말풍선·시간·취소 버튼을 한 줄로. 시간은 말풍선 밖 아래쪽에 붙는다.
            내 메시지는 오른쪽 정렬이라 시간(과 취소 버튼)이 말풍선 왼쪽
            (대화창 가운데 쪽)에 놓인다 — 카카오톡과 같은 배치다. */}
        <div className="bubble-line">
          {onCancel && (
            <button className="msg-cancel" onClick={onCancel} title="취소" aria-label="보낸 것 취소">
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
          )}
          {mine && <span className="bubble-time">{time}</span>}
          {body}
          {!mine && <span className="bubble-time">{time}</span>}
        </div>
      </div>
    </div>
  );
}
