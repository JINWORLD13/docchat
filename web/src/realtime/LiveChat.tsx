import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!nickname) return;

    const onRooms = (list: RoomSummary[]) => setRooms(list);
    const onError = (text: string) => setError(text);

    socket.on("rooms", onRooms);
    socket.on("chatError", onError);
    socket.connect();
    socket.emit("hello", { nickname });

    return () => {
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
