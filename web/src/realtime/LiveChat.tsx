import { useEffect, useRef, useState } from "react";
import Nickname from "./Nickname";
import RoomList from "./RoomList";
import Room from "./Room";
import { socket } from "./socket";
import { loadClientKey, loadNickname, loadRoom, saveNickname, saveRoom } from "./session";
import type { RoomSummary } from "./types";

// 실시간 채팅 탭 전체.
//
// 화면은 세 단계다: 닉네임 입력 → 로비(방 목록) → 방 안.
// 소켓 연결과 방 목록은 여기가 관리하고, 방 하나의 대화는 Room이 맡는다.
// 이렇게 나눈 이유: 방을 옮겨도 소켓은 계속 붙어 있어야 목록이 실시간으로
// 갱신된다. 연결을 Room이 들고 있으면 방을 나갈 때마다 끊겼다 붙는다.
export default function LiveChat() {
  // 초기값을 탭 저장소에서 읽는다 (session.ts).
  // 다른 탭을 눌렀다 돌아오면 이 컴포넌트는 새로 마운트된다 — 그때 닉네임과
  // 방을 여기서 되찾지 않으면 매번 닉네임 입력부터 다시 시작하게 된다.
  const [nickname, setNickname] = useState<string | null>(loadNickname);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<string | null>(loadRoom);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 서버가 알려준 내 공개 신원. 이게 있어야 "내 메시지"를 판단할 수 있다.
  const [authorId, setAuthorId] = useState<string | null>(null);
  // 지금 서버에 붙어 있나. 끊긴 걸 화면이 모르면, 보낸 메시지가 조용히 사라진다.
  const [connected, setConnected] = useState(socket.connected);

  // 재연결 시 어느 방으로 돌아가야 하는지. state를 그대로 쓰면 아래 effect가
  // [nickname]에만 걸려 있어 방을 옮겨도 옛 값이 잡힌다.
  const roomRef = useRef<string | null>(null);
  roomRef.current = room;

  useEffect(() => {
    if (!nickname) return;

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
      setConnected(true);
      // clientKey를 같이 보낸다 — 서버는 이걸로 신원(authorId)을 만든다.
      // 재연결해도 같은 값이라야 새로고침 후에도 자기 방을 지울 수 있다.
      socket.emit("hello", { nickname, clientKey: loadClientKey() });
      if (roomRef.current) socket.emit("join", { room: roomRef.current });
    };

    // 끊긴 걸 화면이 알아야 한다.
    //
    // 예전엔 이 리스너가 아예 없었다. socket.io는 조용히 재연결을 시도하는데,
    // 그동안 보낸 메시지는 버퍼에 쌓였다가 재연결 직후 hello보다 먼저 서버에
    // 도착한다. 서버 입장에서는 닉네임도 방도 없는 소켓이 보낸 것이라 그냥
    // 버린다 — 오류조차 안 돌아오고, 입력창은 비워져서 보낸 것처럼 보인다.
    // 무료 티어 콜드스타트(수십 초)마다 밟는 길이라 흔한 일이다.
    const onDisconnect = () => setConnected(false);
    const onMe = (id: string) => setAuthorId(id);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("me", onMe);
    socket.on("rooms", onRooms);
    socket.on("roomClosed", onRoomClosed);
    socket.on("chatError", onError);

    // 이미 붙어 있으면 connect 이벤트가 다시 오지 않는다(StrictMode 이중 실행 등).
    if (socket.connected) onConnect();
    else socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("me", onMe);
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
  }, [nickname]);

  if (!nickname) {
    return (
      <Nickname
        onSubmit={(nick) => {
          saveNickname(nick);
          setNickname(nick);
        }}
      />
    );
  }

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
        authorId={authorId}
        nickname={nickname}
        connected={connected}
        onSelect={selectRoom}
        onDelete={removeRoom}
      />

      {room ? (
        // key={room}: 방을 옮기면 Room을 새로 마운트해 이전 방의 메시지를 비운다.
        <Room
          key={room}
          nickname={nickname}
          authorId={authorId}
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
            브라우저 탭을 두 개 열고 같은 방에 들어가면 실시간으로 대화가 오갑니다.
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
