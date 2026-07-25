import { useEffect, useRef, useState } from "react";
import Nickname from "./Nickname";
import RoomList from "./RoomList";
import Room from "./Room";
import { socket } from "./socket";
import type { RoomSummary } from "./types";

// 실시간 채팅 탭 전체.
//
// 화면은 세 단계다: 닉네임 입력 → 로비(방 목록) → 방 안.
// 소켓 연결과 방 목록은 여기가 관리하고, 방 하나의 대화는 Room이 맡는다.
// 이렇게 나눈 이유: 방을 옮겨도 소켓은 계속 붙어 있어야 목록이 실시간으로
// 갱신된다. 연결을 Room이 들고 있으면 방을 나갈 때마다 끊겼다 붙는다.
export default function LiveChat() {
  const [nickname, setNickname] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 재연결 시 어느 방으로 돌아가야 하는지. state를 그대로 쓰면 아래 effect가
  // [nickname]에만 걸려 있어 방을 옮겨도 옛 값이 잡힌다.
  const roomRef = useRef<string | null>(null);
  roomRef.current = room;

  useEffect(() => {
    if (!nickname) return;

    const onRooms = (list: RoomSummary[]) => setRooms(list);
    const onError = (text: string) => setError(text);

    // 연결될 때마다 핸드셰이크를 처음부터 다시 한다.
    //
    // 이게 없으면 조용히 망가진다. socket.io는 기본으로 자동 재연결하는데,
    // 재연결은 "같은 연결의 복구"가 아니라 새 소켓이다 — 서버 쪽 socket.data는
    // 비어 있고, 닉네임도 방도 없다. 그런데 클라이언트는 리스너가 그대로 붙어
    // 있어 화면상 아무 변화가 없다. 그 상태로 보낸 메시지는 서버가 로비로 보고
    // 그냥 버린다(오류조차 안 돌아온다). 입력창은 비워지니 보낸 것처럼 보인다.
    //
    // 순서가 중요하다: 서버는 hello(닉네임) 없이 join을 받으면 거절한다.
    // 그래서 재입장은 반드시 여기 한 곳에서 hello → join 순으로 내보낸다.
    // Room이 각자 하면 React가 자식 effect를 먼저 실행해 join이 앞질러 나간다.
    const onConnect = () => {
      socket.emit("hello", { nickname });
      if (roomRef.current) socket.emit("join", { room: roomRef.current });
    };

    socket.on("connect", onConnect);
    socket.on("rooms", onRooms);
    socket.on("chatError", onError);

    // 이미 붙어 있으면 connect 이벤트가 다시 오지 않는다(StrictMode 이중 실행 등).
    if (socket.connected) onConnect();
    else socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("rooms", onRooms);
      socket.off("chatError", onError);
      socket.disconnect();
      setRooms([]);
      setRoom(null);
    };
  }, [nickname]);

  if (!nickname) {
    return <Nickname onSubmit={setNickname} />;
  }

  function selectRoom(name: string) {
    setError(null);
    setRoom(name);
  }

  function leaveRoom() {
    socket.emit("leave"); // 연결은 유지한 채 방에서만 빠진다 (로비로)
    setError(null); // 방에서 받은 경고(도배 제한 등)를 로비까지 들고 가지 않는다
    setRoom(null);
  }

  return (
    <div className="live">
      <RoomList rooms={rooms} current={room} nickname={nickname} onSelect={selectRoom} />

      {room ? (
        // key={room}: 방을 옮기면 Room을 새로 마운트해 이전 방의 메시지를 비운다.
        <Room
          key={room}
          nickname={nickname}
          room={room}
          error={error}
          onDismissError={() => setError(null)}
          onLeave={leaveRoom}
        />
      ) : (
        <div className="live-empty">
          <p className="live-empty-title">방을 고르거나 새로 만들어주세요.</p>
          <p className="live-empty-sub">
            브라우저 탭을 두 개 열고 같은 방에 들어가면 실시간으로 대화가 오갑니다.
          </p>
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
