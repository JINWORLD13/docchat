// 실시간 채팅 게이트웨이 (Socket.IO).
//
// 왜 문서 Q&A와 같은 서버·같은 포트에 붙였나:
// 두 기능은 "실시간"이라는 말은 같지만 필요한 방향이 다르다.
// - 문서 Q&A 답변: 서버 → 클라이언트 한 방향. 토큰이 순서대로 흘러가기만 하면
//   되므로 SSE로 충분하다(HTTP 그대로라 프록시·재연결이 공짜).
// - 채팅: 양방향이고, 한 사람의 발화를 방 전체(1:N)에 밀어줘야 한다.
//   SSE로는 보내는 쪽을 매번 별도 POST로 처리해야 해서 WebSocket이 맞다.
// 즉 전송 방식은 다르지만 서버를 나눌 이유는 없다. 프로세스를 하나로 두면
// 포트·배포·CORS가 하나로 유지되고, rate limit 같은 방어 로직도 공유된다.
//
// 접속 흐름은 두 단계다: hello(닉네임 등록 → 로비) → join(방 입장).
// 닉네임과 방을 한 번에 받지 않는 이유는, 방을 고르려면 먼저 어떤 방이
// 있는지 봐야 하고, 방 목록을 보여주려면 이미 소켓이 붙어 있어야 하기 때문이다.

import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import type {
  ChatMessage,
  ClientToServer,
  ImageMessage,
  ServerToClient,
  SocketData,
  TextMessage,
} from "./types.ts";
import { describeImage, imageUrl } from "../images.ts";
import {
  addUser,
  removeUser,
  onlineUsers,
  addMessage,
  history,
  roomList,
} from "./rooms.ts";
import { allowMessage, dropBucket } from "./ratelimit.ts";

const MAX_NICK = 20;
const MAX_ROOM = 30;
const MAX_TEXT = 500;

export type ChatServer = Server<
  ClientToServer,
  ServerToClient,
  Record<string, never>,
  SocketData
>;

type ChatSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export function attachRealtime(httpServer: HttpServer): ChatServer {
  // 제네릭으로 이벤트 계약을 못박는다. 이제 socket.emit/on이 타입 체크된다.
  const io: ChatServer = new Server(httpServer, {
    // HTTP 쪽 app.use(cors())와 같은 수준으로 맞춘다. 실제 배포에서는 양쪽 다
    // 허용 오리진을 명시해야 한다 — 여기가 열려 있으면 아무 사이트나 이 채팅
    // 서버에 붙을 수 있다.
    cors: { origin: "*" },
  });

  // 방 목록은 로비에 있는 사람도 봐야 하므로 특정 방이 아니라 전원에게 보낸다.
  // 방 구성이 바뀌는 지점(입장·이동·퇴장·연결종료)마다 부른다.
  const broadcastRooms = (): void => {
    io.emit("rooms", roomList());
  };

  // 지금 있는 방에서 빼낸다. 방을 옮길 때와 완전히 나갈 때 둘 다 쓴다.
  // 반환값은 "실제로 어딘가에서 나왔는지" — 목록을 다시 뿌릴지 판단하는 데 쓴다.
  const leaveCurrentRoom = (socket: ChatSocket): boolean => {
    const { nickname, room } = socket.data;
    if (!room) return false;

    removeUser(room, socket.id);
    socket.leave(room);
    io.to(room).emit("presence", onlineUsers(room));
    if (nickname) socket.to(room).emit("system", `${nickname} 님이 나갔어요`);
    socket.data.room = undefined;
    return true;
  };

  io.on("connection", (socket) => {
    // 1단계: 닉네임만 등록하고 로비로. 아직 어느 방에도 속하지 않는다.
    socket.on("hello", ({ nickname }) => {
      const nick = (nickname ?? "").trim().slice(0, MAX_NICK);
      if (!nick) {
        socket.emit("chatError", "닉네임을 입력해주세요.");
        return;
      }
      socket.data.nickname = nick;
      socket.emit("rooms", roomList()); // 방금 들어온 사람에게 현재 목록
    });

    // 2단계: 방 입장. 없는 이름이면 그 자리에서 만들어진다(= 방 생성).
    // 이미 다른 방에 있었다면 먼저 거기서 빠져나온다(방 이동).
    socket.on("join", ({ room }) => {
      const { nickname } = socket.data;
      if (!nickname) {
        socket.emit("chatError", "먼저 닉네임을 정해주세요.");
        return;
      }

      const roomName = (room ?? "").trim().slice(0, MAX_ROOM);
      if (!roomName) {
        socket.emit("chatError", "방 이름을 입력해주세요.");
        return;
      }
      // 이미 있는 방을 또 join한 경우(목록에서 현재 방을 다시 누르거나,
      // React StrictMode가 개발 모드에서 effect를 두 번 실행하는 경우).
      // 상태는 건드리지 않고 화면을 채울 것만 다시 보낸다. 여기서 그냥
      // return해버리면, 재구독 직전에 도착한 history를 놓쳐 방이 빈 채로 보인다.
      // 입장 알림을 다시 보내지 않는 게 핵심 — 방에 중복으로 뜬다.
      if (roomName === socket.data.room) {
        socket.emit("history", history(roomName));
        socket.emit("presence", onlineUsers(roomName));
        return;
      }

      leaveCurrentRoom(socket);

      socket.data.room = roomName;
      socket.join(roomName);
      addUser(roomName, socket.id, nickname);

      socket.emit("history", history(roomName)); // 나에게만 최근 기록
      io.to(roomName).emit("presence", onlineUsers(roomName)); // 방 전체에 접속자 목록
      socket.to(roomName).emit("system", `${nickname} 님이 입장했어요`); // 나 빼고 알림
      broadcastRooms(); // 방이 새로 생겼거나 인원이 바뀌었다
    });

    // 방만 나가고 로비로 돌아간다 (연결은 유지 — 방 목록은 계속 본다).
    socket.on("leave", () => {
      if (leaveCurrentRoom(socket)) broadcastRooms();
    });

    // 텍스트든 이미지든 방에 내보내는 절차는 같다 — 로비인지 확인하고,
    // 도배 제한을 태우고, 서버가 id·시각을 붙여 방 전체에 뿌린다.
    // 그 공통 부분만 여기 모아둔다. build가 null을 주면 보낼 게 없다는 뜻.
    const publish = (
      build: (base: { id: string; room: string; nickname: string; ts: number }) => ChatMessage | null
    ): void => {
      const { nickname, room } = socket.data;
      if (!nickname || !room) return; // 로비에 있으면 무시

      if (!allowMessage(socket.id)) {
        socket.emit("chatError", "너무 빨리 보내고 있어요. 잠시 후 다시 시도해주세요.");
        return;
      }

      // id와 ts는 서버가 붙인다. 클라이언트 시계는 틀릴 수 있고, 방 전체가
      // 같은 기준으로 정렬되려면 한 곳에서 찍어야 한다.
      const message = build({ id: randomUUID(), room, nickname, ts: Date.now() });
      if (!message) return;

      addMessage(message);
      io.to(room).emit("message", message); // 방에 있는 모두에게
    };

    // 메시지: 도배 제한을 통과하면 방 전체에 브로드캐스트 (1:N 전달의 핵심)
    socket.on("message", ({ text }) => {
      const trimmed = (text ?? "").trim().slice(0, MAX_TEXT);
      if (!trimmed) return; // 빈 메시지는 도배 토큰도 쓰지 않게 앞에서 거른다

      publish((base): TextMessage => ({ ...base, kind: "text", text: trimmed }));
    });

    // 이미지: 클라이언트는 업로드로 받은 id만 보낸다.
    //
    // 주소(url)를 클라이언트에게 받지 않는 게 핵심이다. 받으면 임의의 주소를
    // 방 전체에 뿌릴 수 있고, 방에 있던 사람들의 브라우저가 그 주소로 요청을
    // 보내게 된다(IP 노출·추적). 그래서 id가 우리가 발급한 것인지 DB에서
    // 확인하고, 주소는 서버가 만든다.
    socket.on("image", ({ imageId }) => {
      const { nickname, room } = socket.data;
      if (!nickname || !room) return;

      void (async () => {
        try {
          // 크기만 읽는다. 바이트는 브라우저가 url로 따로 받아간다 —
          // 메시지를 뿌릴 때마다 수백 KB를 DB에서 끌어올 이유가 없다.
          const meta = await describeImage(imageId);
          if (!meta) {
            socket.emit("chatError", "이미지를 찾을 수 없어요. 다시 올려주세요.");
            return;
          }
          publish(
            (base): ImageMessage => ({
              ...base,
              kind: "image",
              url: imageUrl(imageId),
              width: meta.width,
              height: meta.height,
            })
          );
        } catch (e) {
          // async 핸들러라 여기서 안 잡으면 프로세스 전체가 unhandled rejection으로 죽는다.
          console.error("image message 실패:", e instanceof Error ? e.message : e);
          socket.emit("chatError", "이미지를 보내지 못했어요.");
        }
      })();
    });

    // 입력 중 표시: 나를 제외한 방 사람들에게만
    socket.on("typing", () => {
      const { nickname, room } = socket.data;
      if (nickname && room) socket.to(room).emit("typing", nickname);
    });

    // 연결 종료: 방에서 빼고 목록 갱신, 버킷 정리
    socket.on("disconnect", () => {
      if (leaveCurrentRoom(socket)) broadcastRooms();
      dropBucket(socket.id);
    });
  });

  return io;
}
