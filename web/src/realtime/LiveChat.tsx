import { useEffect, useRef, useState } from "react";
import RoomList from "./RoomList";
import Room from "./Room";
import { socket } from "./socket";
import { loadRoom, saveRoom } from "./session";
import { notifySessionExpired } from "../api";
import type { RoomSummary } from "./types";
import type { Me } from "../types";

interface Props {
  // 로그인한 나(App.tsx가 준다). 신원 화면이 여기서 사라진 이유다 —
  // 예전의 닉네임 입력 단계는 앱 전체의 문(AuthGate)으로 올라갔다.
  me: Me;
}

// 실시간 채팅 탭 전체.
//
// 화면은 두 단계다: 로비(방 목록) → 방 안. (닉네임 단계는 로그인으로 대체됐다)
// 소켓 연결과 방 목록은 여기가 관리하고, 방 하나의 대화는 Room이 맡는다.
// 이렇게 나눈 이유: 방을 옮겨도 소켓은 계속 붙어 있어야 목록이 실시간으로
// 갱신된다. 연결을 Room이 들고 있으면 방을 나갈 때마다 끊겼다 붙는다.
export default function LiveChat({ me }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<string | null>(loadRoom);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 지금 서버에 붙어 있나. 끊긴 걸 화면이 모르면, 보낸 메시지가 조용히 사라진다.
  const [connected, setConnected] = useState(socket.connected);

  // 재연결 시 어느 방으로 돌아가야 하는지. state를 그대로 쓰면 아래 effect가
  // 마운트에만 걸려 있어 방을 옮겨도 옛 값이 잡힌다.
  const roomRef = useRef<string | null>(null);
  roomRef.current = room;

  useEffect(() => {
    const onRooms = (list: RoomSummary[]) => setRooms(list);
    const onError = (text: string) => setError(text);

    // 있던 방이 삭제됐다. 서버가 이미 우리를 방에서 빼놨으므로 화면만 로비로
    // 돌린다("leave"를 보내면 안 된다 — 나올 방이 없다).
    // 저장해둔 방도 지운다. 안 지우면 탭을 옮겼다 돌아올 때 그 이름으로 join이
    // 나가서, 방금 지운 방이 (이번엔 나를 방장으로) 되살아난다.
    const onRoomClosed = (closed: string) => {
      if (roomRef.current !== closed) return; // 내가 있던 방이 아니면 목록 갱신으로 충분
      saveRoom(null);
      setRoom(null);
      setError(null);
      setNotice(`#${closed} 방이 삭제되었어요.`);
    };

    // 연결될 때마다 있던 방으로 다시 들어간다.
    //
    // 신원은 핸드셰이크의 세션 쿠키가 증명한다(서버 gateway.ts의 io.use) —
    // 예전처럼 hello(닉네임 등록)를 다시 보낼 필요가 없어졌다. 하지만 재연결이
    // "같은 연결의 복구"가 아니라 새 소켓이라는 사실은 그대로라(서버 쪽
    // socket.data.room이 비어 있다), 재입장은 여전히 여기서 해야 한다.
    const onConnect = () => {
      setConnected(true);
      if (roomRef.current) socket.emit("join", { room: roomRef.current });
    };

    // 끊긴 걸 화면이 알아야 한다. socket.io는 조용히 재연결을 시도하는데,
    // 그동안 보낸 메시지는 서버가 그냥 버린다(Room의 send 주석).
    const onDisconnect = () => setConnected(false);

    // 연결 자체가 거절됐다. 조용히 재시도만 반복하면 "연결 중…"에서 영원히
    // 머무니까 이유를 화면에 올린다.
    //
    // 세션이 없어서 거절된 경우는 이 화면에서 해결할 수 없다. 채팅 탭에만
    // 앉아 있으면 HTTP 요청이 하나도 안 나가서 401을 만날 일이 없고, 소켓은
    // 계속 거절당하므로 오류 문구만 반복되는 화면에 갇힌다. 그래서 그때는
    // 앱 전체를 로그인 화면으로 돌린다(App.tsx가 등록해둔 곳).
    // 사유는 문구가 아니라 서버가 실어 보낸 코드로 판단한다 — 문구로 판단하면
    // 서버에서 말을 다듬는 순간 조용히 깨진다(server/realtime/gateway.ts).
    const onConnectError = (err: Error) => {
      setConnected(false);
      const { data } = err as Error & { data?: { code?: string } };
      if (data?.code === "unauthorized") {
        notifySessionExpired();
        return;
      }
      setError(err.message || "연결에 실패했어요.");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("rooms", onRooms);
    socket.on("roomClosed", onRoomClosed);
    socket.on("chatError", onError);

    // 이미 붙어 있으면 connect 이벤트가 다시 오지 않는다(StrictMode 이중 실행 등).
    if (socket.connected) onConnect();
    else socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("rooms", onRooms);
      socket.off("roomClosed", onRoomClosed);
      socket.off("chatError", onError);
      socket.disconnect();
      setRooms([]); // 목록은 다시 붙는 순간 서버가 새로 밀어준다

      // 여기서 setRoom(null)을 하면 안 된다.
      //
      // StrictMode는 개발 모드에서 effect를 mount → cleanup → effect 순으로
      // 한 번 더 돌린다. 그 cleanup은 "진짜 언마운트"가 아니라 컴포넌트가 살아
      // 있는 상태에서 실행되므로, 여기서 부른 setRoom(null)은 그대로 반영된다.
      // 그러면 저장소에서 막 복구해둔 방이 첫 마운트에서 지워지고, 뒤이어 도는
      // onConnect가 roomRef.current === null을 보고 join을 보내지 않는다 —
      // 탭을 옮겼다 돌아오면 방이 사라진 것처럼 보인다.
      // (실제 언마운트라면 state는 어차피 함께 사라지므로 지울 필요도 없다)
    };
  }, []);

  function selectRoom(name: string) {
    setError(null);
    setNotice(null);
    saveRoom(name);
    setRoom(name);
  }

  function leaveRoom() {
    socket.emit("leave"); // 연결은 유지한 채 방에서만 빠진다 (로비로)
    setError(null); // 방에서 받은 경고(도배 제한 등)를 로비까지 들고 가지 않는다
    saveRoom(null);
    setRoom(null);
  }

  // 방 삭제. 권한 확인은 서버가 한다 — 목록의 ownerId는 버튼을 보여줄지 정하는
  // 힌트일 뿐이고, 클라이언트가 보낸 값은 어차피 못 믿는다.
  function removeRoom(name: string) {
    setError(null);
    setNotice(null);
    socket.emit("deleteRoom", { room: name });
  }

  return (
    <div className="live">
      <RoomList
        rooms={rooms}
        current={room}
        authorId={me.id}
        nickname={me.displayName}
        connected={connected}
        onSelect={selectRoom}
        onDelete={removeRoom}
      />

      {room ? (
        // key={room}: 방을 옮기면 Room을 새로 마운트해 이전 방의 메시지를 비운다.
        <Room
          key={room}
          nickname={me.displayName}
          authorId={me.id}
          room={room}
          connected={connected}
          error={error}
          onDismissError={() => setError(null)}
          onLeave={leaveRoom}
        />
      ) : (
        <div className="live-empty">
          {!connected && (
            <div className="chat-offline">서버와 연결이 끊겼어요. 다시 연결하는 중…</div>
          )}
          <p className="live-empty-title">방을 고르거나 새로 만들어주세요.</p>
          <p className="live-empty-sub">
            다른 브라우저(또는 시크릿 창)로 다른 계정을 만들어 같은 방에 들어가면
            실시간으로 대화가 오갑니다.
          </p>
          {notice && (
            <div className="chat-notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}
          {error && (
            <div className="chat-error" onClick={() => setError(null)}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
