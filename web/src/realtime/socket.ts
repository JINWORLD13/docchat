import { io, type Socket } from "socket.io-client";
import type { ClientToServer, ServerToClient } from "./types";

// 클라이언트 관점에선 듣는 이벤트(ServerToClient)와 보내는 이벤트(ClientToServer)의
// 순서가 서버와 반대다. 이렇게 타입을 주면 socket.emit/on이 전부 타입 체크된다.
//
// io()에 주소를 안 넘기면 같은 오리진에 붙는다. 서버 주소를 환경변수로 따로
// 들고 있지 않아도 되는 이유는, 채팅 서버가 문서 Q&A와 같은 프로세스·같은
// 포트에 있고 개발 중엔 Vite가 /socket.io를 그쪽으로 프록시하기 때문이다.
export const socket: Socket<ServerToClient, ClientToServer> = io({
  autoConnect: false, // 채팅 탭에 들어가 방에 입장할 때 직접 connect() 한다
});
