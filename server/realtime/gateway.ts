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
// 접속 흐름: 로그인 세션으로 연결(핸드셰이크에서 인증 — 아래 io.use) → join(방 입장).
// 연결만 하면 로비다 — 방 목록을 보여주려면 소켓이 먼저 붙어 있어야 하기 때문이다.

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
import { describeImage, imageUrl, idFromUrl, deleteImage } from "../images.ts";
import {
  addUser,
  removeUser,
  onlineUsers,
  addMessage,
  history,
  roomList,
  canJoin,
  sweepRooms,
  deleteRoom,
  removeMessage,
  imageInUse,
} from "./rooms.ts";
import { allowMessage, allowAction, allowHandshake, addSocket, removeSocket } from "./ratelimit.ts";
import { readString } from "./payload.ts";
import { isAllowedOrigin } from "../origins.ts";
import { clientIp } from "../clientip.ts";
import { onSessionDestroyed, sessionUser, tokenFromCookieHeader } from "../auth.ts";

const MAX_ROOM = 30;
const MAX_TEXT = 500;

// 비운 지 오래된 방을 치우는 주기.
const ROOM_SWEEP_MS = 60_000;

// id는 우리가 발급한 uuid만 받는다 (routes/images.ts와 같은 기준).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 핸드셰이크를 거절하면서 "세션이 없어서"라는 사유를 함께 싣는다.
// socket.io는 미들웨어 에러의 message와 data를 그대로 클라이언트의
// connect_error로 넘겨준다. HTTP의 401에 해당하는 신호다.
function unauthorized(message: string): Error {
  const err = new Error(message);
  (err as Error & { data?: unknown }).data = { code: "unauthorized" };
  return err;
}

// 소켓 페이로드는 타입이 지켜주지 않는다. 왜 그런지와 무엇이 문제였는지는
// payload.ts에 적어뒀다 — 이 파일에서 가장 중요한 한 줄짜리 방어다.

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
    // HTTP와 같은 판정을 쓴다(../origins.ts). 한쪽만 잠그면 의미가 없다.
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },

    // cors 옵션만으로는 실제로 아무것도 막지 못한다.
    //
    // engine.io는 cors 미들웨어를 헤더 붙이는 용도로만 쓰고, 오리진이 목록에
    // 없으면 Access-Control-Allow-Origin을 빼고 그냥 next()를 부른다 — 요청은
    // 그대로 처리된다. 게다가 브라우저는 WebSocket 핸드셰이크에 CORS를 적용하지
    // 않으므로, transports를 websocket으로 고정한 클라이언트는 검사 자체를
    // 건너뛴다. 실제로 아무 오리진에서나 붙어 방 목록을 받고 메시지를 보낼 수
    // 있었다. "cors를 설정했으니 막혔다"고 믿고 있던 자리다.
    //
    // allowRequest는 polling이든 websocket 업그레이드든 핸드셰이크 전에 불리므로
    // 여기서 거절해야 실제로 닫힌다. host를 같이 넘기는 이유는 배포 때문이다 —
    // 프런트를 같은 오리진에서 서빙하므로 우리 화면의 Origin은 자기 자신이고,
    // 그건 CORS_ORIGINS 목록에 없다(origins.ts의 isSameOrigin).
    allowRequest: (req, done) => {
      const ok = isAllowedOrigin(req.headers.origin, req.headers.host);
      done(ok ? null : "origin not allowed", ok);
    },
  });

  // 연결 자체가 인증이다. 핸드셰이크의 세션 쿠키로 사용자를 확인하고,
  // 없으면 연결을 거절한다 — HTTP 라우트가 userFromRequest로 하는 일의
  // 소켓판이다. 예전의 hello(닉네임 등록) 단계는 이걸로 사라졌다: 이름도
  // 신원도 계정에서 온다.
  //
  // 미들웨어에서 끊는 게 중요하다. connection 핸들러 안에서 검사하면 그
  // 전에 이미 rooms 브로드캐스트 대상에 들어가, 로그인 없이도 방 목록을
  // 받아볼 수 있다.
  io.use((socket, next) => {
    void (async () => {
      // 세션 조회 앞의 제한. 핸드셰이크는 인증 성공 뒤의 IP당 연결 상한
      // (아래 addSocket)에 안 세어지므로, 여기 제한이 없으면 지어낸 64자리
      // hex 쿠키로 연결 시도를 반복하는 것만으로 시도당 DB 조회 한 번씩을
      // 강제할 수 있다 — index.ts가 rateLimit을 requireLogin 앞에 두는 것과
      // 같은 이유다(싼 검사가 비싼 검사보다 앞).
      const ip = clientIp(socket.handshake.address, socket.handshake.headers["x-forwarded-for"]);
      if (!allowHandshake(ip)) {
        next(new Error("연결 시도가 너무 잦아요. 잠시 후 다시 시도해주세요."));
        return;
      }

      const token = tokenFromCookieHeader(socket.handshake.headers.cookie);
      const user = token ? await sessionUser(token) : null;
      if (!user) {
        // 세션이 없다는 사실에 표식을 단다. 화면은 이걸 보고 로그인 화면으로
        // 돌아간다(web/realtime/LiveChat.tsx) — 없으면 채팅 탭에 앉아 있는
        // 사람은 HTTP 요청을 하나도 안 보내므로 401을 만날 일이 없고,
        // "연결에 실패했어요"만 반복하는 화면에 갇힌다.
        // 문구가 아니라 코드로 주는 이유는 문구가 언제든 바뀌기 때문이다.
        next(unauthorized("로그인이 필요해요."));
        return;
      }
      socket.data.user = { id: user.id, displayName: user.displayName };
      // 로그아웃이 이 소켓을 찾을 수 있게 토큰을 붙여둔다(아래 onSessionDestroyed).
      socket.data.sessionToken = token ?? undefined;
      next();
    })().catch(() =>
      // 여기는 세션 조회 자체가 터진 경우다(DB 장애 등). 표식을 달지 않는다 —
      // 이걸 "로그인 안 됨"으로 알리면 DB가 잠깐 흔들린 것이 전원 강제
      // 로그아웃이 된다. requireLogin이 같은 상황을 401이 아니라 500으로
      // 올려보내는 것과 같은 이유다(auth.ts).
      next(new Error("로그인 확인에 실패했어요."))
    );
  });

  // 로그아웃(세션 파기)이 그 세션으로 붙어 있던 소켓을 끊는다.
  //
  // 연결 인증은 핸드셰이크 한 번뿐이라, 이게 없으면 로그아웃해도 이미 붙은
  // 소켓은 파기된 신원으로 무기한 대화가 된다 — 채팅 탭은 HTTP 요청을 안
  // 보내므로 401을 만날 일이 없다. 세션을 DB에 둔 이유가 "공용 PC에서
  // 로그아웃하면 정말로 로그아웃"(schema.sql)인데, 소켓 경로만 그 보증에서
  // 빠져 있던 구멍이다. 쿠키를 탈취당한 경우도 같다 — 로그아웃이 탈취자의
  // 열린 소켓까지 끊어야 세션 파기가 완결된다.
  //
  // 전 소켓 순회는 O(연결 수)지만 로그아웃은 드물고 연결은 기껏 수백이라 충분하다.
  // 30일 자연 만료는 일부러 안 끊는다 — 대화 중에 조용히 끊기는 것보다, 다음
  // 재연결이 핸드셰이크에서 거절되는 쪽이 낫다.
  onSessionDestroyed((token) => {
    for (const [, member] of io.sockets.sockets) {
      if (member.data.sessionToken === token) member.disconnect(true);
    }
  });

  // 방 목록은 로비에 있는 사람도 봐야 하므로 특정 방이 아니라 전원에게 보낸다.
  // 방 구성이 바뀌는 지점(입장·이동·퇴장·연결종료)마다 부른다.
  const broadcastRooms = (): void => {
    io.emit("rooms", roomList());
  };

  // 지금 있는 방에서 빼낸다. 방을 옮길 때와 완전히 나갈 때 둘 다 쓴다.
  // 반환값은 "실제로 어딘가에서 나왔는지" — 목록을 다시 뿌릴지 판단하는 데 쓴다.
  const leaveCurrentRoom = (socket: ChatSocket): boolean => {
    const { user, room } = socket.data;
    if (!room) return false;

    removeUser(room, socket.id);
    socket.leave(room);
    io.to(room).emit("presence", onlineUsers(room));
    if (user) socket.to(room).emit("system", `${user.displayName} 님이 나갔어요`);
    socket.data.room = undefined;
    return true;
  };

  // 지금 이 방에 들어가 있는 소켓들.
  // adapter가 들고 있는 socket id로 실제 소켓 객체를 찾는다. socketsLeave()처럼
  // 한 번에 내보내는 API도 있지만, 그건 소켓에 붙여둔 socket.data.room을
  // 건드리지 않는다 — 그 값이 남으면 아래 deleteRoom에서 문제가 된다.
  // (방 상태를 메모리에 두는 것과 같은 전제: 서버 한 대)
  const roomMembers = (roomName: string): ChatSocket[] => {
    const ids = io.sockets.adapter.rooms.get(roomName);
    if (!ids) return [];
    const found: ChatSocket[] = [];
    for (const id of ids) {
      const member = io.sockets.sockets.get(id);
      if (member) found.push(member);
    }
    return found;
  };

  // 방 청소 타이머. unref()라 이 타이머 때문에 프로세스가 살아 있진 않는다.
  setInterval(() => sweepRooms(), ROOM_SWEEP_MS).unref();

  io.on("connection", (socket) => {
    // 제한과 회수의 기준이 되는 값. socket.id는 재연결마다 새로 생겨서
    // 제한의 키로 쓸 수 없다(realtime/ratelimit.ts 참고).
    //
    // handshake.address를 그대로 쓰면 안 된다. 그건 TCP 연결의 주소라,
    // 로드밸런서 뒤에서는 접속자 전원이 프록시 IP 하나로 보인다 —
    // "IP당" 제한이 "전체 공용" 제한이 되고, IP당 동시 연결 상한 때문에
    // 11번째 방문자부터 연결이 끊긴다. Express의 trust proxy는 HTTP에만
    // 적용되므로 소켓 쪽은 같은 계산을 직접 해준다(../clientip.ts).
    const ip = clientIp(socket.handshake.address, socket.handshake.headers["x-forwarded-for"]);

    // IP당 동시 연결 상한. 넘으면 붙자마자 끊는다 — 여기서 막지 않으면
    // 아래의 IP별 제한을 연결 수만큼 곱해서 우회할 수 있다.
    if (!addSocket(ip)) {
      socket.emit("chatError", "연결이 너무 많아요. 열려 있는 탭을 닫고 다시 시도해주세요.");
      socket.disconnect(true);
      return;
    }

    // 메시지가 아닌 이벤트(방 이동·입력중)의 제한. 조용히 무시한다 —
    // 사용자가 직접 누른 동작이 아니라 화면 뒤에서 자동으로 나가는 것들이라,
    // 여기서 오류를 띄우면 정상 사용자에게 영문 모를 경고만 뜬다.
    const allowedAction = (): boolean => allowAction(ip);

    // 막 연결된 사람에게 현재 방 목록을 보낸다. 신원은 미들웨어가 이미
    // 채웠으므로(위 io.use) 예전처럼 닉네임 등록(hello)을 기다릴 필요가 없다.
    socket.emit("rooms", roomList());

    // 2단계: 방 입장. 없는 이름이면 그 자리에서 만들어진다(= 방 생성).
    // 이미 다른 방에 있었다면 먼저 거기서 빠져나온다(방 이동).
    socket.on("join", (payload) => {
      const { user } = socket.data;
      if (!user) return; // 미들웨어가 보장하지만, 타입을 좁히는 겸 한 번 더
      // join 한 번은 방 목록 전체를 접속자 전원에게 밀어내는 1:N 증폭이다.
      // 제한 없이 열어두면 한 명이 그걸 반복해 서버 전체 대역을 먹는다.
      if (!allowedAction()) return;

      const roomName = readString(payload, "room").trim().slice(0, MAX_ROOM);
      if (!roomName) {
        socket.emit("chatError", "방 이름을 입력해주세요.");
        return;
      }
      if (!canJoin(roomName)) {
        socket.emit("chatError", "방이 너무 많아요. 이미 있는 방에 들어가주세요.");
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
      // 없는 방이면 여기서 만들어지고, 이 사람이 방장이 된다(= user id가 주인).
      addUser(roomName, socket.id, user.displayName, user.id);

      socket.emit("history", history(roomName)); // 나에게만 최근 기록
      io.to(roomName).emit("presence", onlineUsers(roomName)); // 방 전체에 접속자 목록
      socket.to(roomName).emit("system", `${user.displayName} 님이 입장했어요`); // 나 빼고 알림
      broadcastRooms(); // 방이 새로 생겼거나 인원이 바뀌었다
    });

    // 방만 나가고 로비로 돌아간다 (연결은 유지 — 방 목록은 계속 본다).
    socket.on("leave", () => {
      if (leaveCurrentRoom(socket)) broadcastRooms();
    });

    // 방 삭제. 만든 사람만 지울 수 있다(권한 판단은 rooms.ts).
    //
    // 방은 마지막 사람이 나가면 알아서 정리되지만, 대화가 오간 방은 유예 시간
    // 동안 목록에 남는다. 잘못 만든 이름이나 다 끝난 방을 바로 치우는 수단이 없으면
    // 로비가 지저분해지고, 지우고 싶은 대화가 30분간 남는다.
    socket.on("deleteRoom", (payload) => {
      const { user } = socket.data;
      if (!user) return;
      // join과 같은 성격의 1:N 증폭이다(목록이 전원에게 다시 나간다).
      if (!allowedAction()) return;

      const roomName = readString(payload, "room").trim().slice(0, MAX_ROOM);
      if (!roomName) return;

      const result = deleteRoom(roomName, user.id);
      if (result === "notfound") {
        socket.emit("chatError", "이미 사라진 방이에요.");
        return;
      }
      if (result === "denied") {
        socket.emit("chatError", "방을 만든 사람만 지울 수 있어요.");
        return;
      }

      // 방에 있던 사람들(지운 사람 포함)을 로비로 내보낸다.
      //
      // socket.data.room을 지우는 게 핵심이다. 남겨두면 그 사람이 보내는 다음
      // 메시지가 publish → addMessage → getRoom을 타고 지운 방을 되살린다.
      // 그것도 방장 없는(owner: "") 방으로 — 아무도 두 번 지울 수 없는 방이 된다.
      for (const member of roomMembers(roomName)) {
        member.data.room = undefined;
        member.leave(roomName);
        member.emit("roomClosed", roomName);
      }
      broadcastRooms();
    });

    // 도배 제한을 태우고, 막혔으면 사용자에게 알린다.
    //
    // publish() 안이 아니라 그 앞에 따로 두는 이유는 이미지 때문이다.
    // 이미지는 publish 전에 DB를 한 번 다녀오는데, 제한이 publish 안에 있으면
    // 정작 비싼 쪽(mediaPool 쿼리)이 무제한으로 열린다 — 제한에 "걸리는" 메시지가
    // 이미 쿼리를 다 쓰고 난 뒤인 셈이라 아무것도 못 막는다.
    const allowedMessage = (): boolean => {
      if (allowMessage(ip)) return true;
      socket.emit("chatError", "너무 빨리 보내고 있어요. 잠시 후 다시 시도해주세요.");
      return false;
    };

    // 텍스트든 이미지든 방에 내보내는 절차는 같다 — 로비인지 확인하고,
    // 서버가 id·시각을 붙여 방 전체에 뿌린다. 그 공통 부분만 여기 모아둔다.
    // build가 null을 주면 보낼 게 없다는 뜻.
    const publish = (
      build: (base: {
        id: string;
        room: string;
        nickname: string;
        authorId: string;
        ts: number;
      }) => ChatMessage | null
    ): void => {
      const { user, room } = socket.data;
      if (!user || !room) return; // 로비에 있으면 무시

      // id와 ts는 서버가 붙인다. 클라이언트 시계는 틀릴 수 있고, 방 전체가
      // 같은 기준으로 정렬되려면 한 곳에서 찍어야 한다.
      // 작성자(authorId)도 서버가 세션에서 꺼내 붙인다 — 이게 곧 취소 권한이라,
      // 보내는 쪽이 정하게 두면 남의 이름으로 글을 쓸 수 있다.
      const message = build({
        id: randomUUID(),
        room,
        nickname: user.displayName,
        authorId: user.id,
        ts: Date.now(),
      });
      if (!message) return;

      // 방이 사라진 뒤 도착한 메시지는 버린다. addMessage가 방을 되살리지
      // 않으므로(rooms.ts), 여기서 false면 보낼 곳이 없다는 뜻이다.
      if (!addMessage(message)) return;
      io.to(room).emit("message", message); // 방에 있는 모두에게
    };

    // 메시지: 도배 제한을 통과하면 방 전체에 브로드캐스트 (1:N 전달의 핵심)
    socket.on("message", (payload) => {
      const trimmed = readString(payload, "text").trim().slice(0, MAX_TEXT);
      if (!trimmed) return; // 빈 메시지는 도배 토큰도 쓰지 않게 앞에서 거른다
      if (!allowedMessage()) return;

      publish((base): TextMessage => ({ ...base, kind: "text", text: trimmed }));
    });

    // 이미지: 클라이언트는 업로드로 받은 id만 보낸다.
    //
    // 주소(url)를 클라이언트에게 받지 않는 게 핵심이다. 받으면 임의의 주소를
    // 방 전체에 뿌릴 수 있고, 방에 있던 사람들의 브라우저가 그 주소로 요청을
    // 보내게 된다(IP 노출·추적). 그래서 id가 우리가 발급한 것인지 DB에서
    // 확인하고, 주소는 서버가 만든다.
    socket.on("image", (payload) => {
      const { user, room } = socket.data;
      if (!user || !room) return;

      // 모양부터 확인한다. 안 하면 쓰레기 문자열 하나가 uuid 컬럼 비교까지
      // 내려가 Postgres 에러를 왕복시킨다 — 거절 한 건에 DB 왕복 한 번씩.
      const imageId = readString(payload, "imageId");
      if (!UUID.test(imageId)) {
        socket.emit("chatError", "이미지를 찾을 수 없어요. 다시 올려주세요.");
        return;
      }
      // DB에 가기 전에 제한을 태운다 (위 allowedMessage 주석 참고).
      if (!allowedMessage()) return;

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

    // 보낸 것 취소: 내가 쓴 메시지·이미지를 방에서 없앤다.
    //
    // 이미지는 방 기록에서 빼는 것만으로 끝나지 않는다. 바이트가 DB에 남아 있으면
    // 주소로 계속 열리기 때문에, 아무도 그 사진을 참조하지 않을 때 행까지 지운다.
    socket.on("deleteMessage", (payload) => {
      const { user, room } = socket.data;
      if (!user || !room) return; // 로비에서는 지울 것이 없다
      // 삭제 한 번은 방 전체로 나가는 1:N이다. join·deleteRoom과 같은 버킷.
      if (!allowedAction()) return;

      // 모양부터 본다 (image 핸들러와 같은 이유).
      const messageId = readString(payload, "messageId");
      if (!UUID.test(messageId)) return;

      const result = removeMessage(room, messageId, user.id);
      if (result.status === "notfound") {
        socket.emit("chatError", "이미 사라진 메시지예요.");
        return;
      }
      if (result.status === "denied") {
        socket.emit("chatError", "내가 보낸 것만 취소할 수 있어요.");
        return;
      }

      // 기록에서 빠진 뒤에 알린다 — 순서가 반대면 이 알림을 받고 다시 들어온
      // 사람이 방금 지운 메시지를 history로 돌려받는다.
      io.to(room).emit("messageDeleted", messageId);

      const removed = result.message;
      if (removed.kind !== "image") return;
      // 같은 사진을 가리키는 메시지가 남아 있으면 바이트는 건드리지 않는다.
      if (imageInUse(removed.url)) return;

      const imageId = idFromUrl(removed.url);
      if (!UUID.test(imageId)) return;
      // 실패해도 메시지는 이미 사라졌다. 바이트는 보관 기간 정리가 걷어가므로
      // 사용자에게 다시 알리지 않고 로그만 남긴다.
      void deleteImage(imageId).catch((e: unknown) => {
        console.error("이미지 삭제 실패:", e instanceof Error ? e.message : e);
      });
    });

    // 입력 중 표시: 나를 제외한 방 사람들에게만.
    // 글자마다 나가는 이벤트라 방 인원수만큼 곱해진다. 메시지와 같은 버킷을
    // 쓰면 정상적으로 타자만 쳐도 발언권이 사라지므로 별도 버킷으로 제한한다.
    socket.on("typing", () => {
      const { user, room } = socket.data;
      if (!user || !room) return;
      if (!allowedAction()) return;
      socket.to(room).emit("typing", user.displayName);
    });

    // 연결 종료: 방에서 빼고 목록 갱신, 이 IP의 마지막 소켓이면 버킷까지 정리
    socket.on("disconnect", () => {
      if (leaveCurrentRoom(socket)) broadcastRooms();
      removeSocket(ip);
    });
  });

  return io;
}
