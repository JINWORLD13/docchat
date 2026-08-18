// 서버(server/realtime/types.ts)와 같은 이벤트 계약.
// 지금은 손으로 맞춰두고, 규모가 커지면 공용 패키지로 뺀다 (../types.ts 주석 참고).

interface ChatMessageBase {
  id: string;
  room: string;
  nickname: string; // 화면에 보이는 이름 (계정의 표시 이름)
  // 보낸 사람의 신원 — 계정의 user id. "내 것인가"(취소 버튼)를 이걸로 판단한다.
  // 이름으로 판단하면 같은 이름을 쓴 사람의 메시지까지 내 것으로 보인다.
  authorId: string;
  ts: number;
}

export interface TextMessage extends ChatMessageBase {
  kind: "text";
  text: string;
}

export interface ImageMessage extends ChatMessageBase {
  kind: "image";
  url: string; // 서버가 만든 주소
  width: number;
  height: number;
}

export type ChatMessage = TextMessage | ImageMessage;

export interface RoomSummary {
  name: string;
  users: number;
  ownerId: string; // 방을 만든 사람의 공개 신원. 이 사람에게만 삭제 버튼이 보인다.
}

// 클라이언트 → 서버
// (hello가 없어진 이유: 신원은 핸드셰이크의 세션 쿠키가 증명한다.
//  서버 realtime/types.ts 주석 참고)
export interface ClientToServer {
  join: (payload: { room: string }) => void;
  leave: () => void;
  deleteRoom: (payload: { room: string }) => void; // 방 삭제 (방장만)
  message: (payload: { text: string }) => void;
  // 이미지는 먼저 POST /api/chat/image로 올리고, 받은 id만 보낸다.
  image: (payload: { imageId: string }) => void;
  // 내가 보낸 것 취소. 이미지면 DB에 있는 바이트까지 지운다.
  deleteMessage: (payload: { messageId: string }) => void;
  typing: () => void;
}

// 서버 → 클라이언트
// (me가 없어진 이유: 내 id는 로그인 응답이 알려준다 — ../types.ts의 Me)
export interface ServerToClient {
  rooms: (rooms: RoomSummary[]) => void;
  history: (messages: ChatMessage[]) => void;
  message: (message: ChatMessage) => void;
  messageDeleted: (messageId: string) => void; // 보낸 사람이 취소했다 (방 전체)
  presence: (users: string[]) => void;
  system: (text: string) => void;
  typing: (nickname: string) => void;
  roomClosed: (room: string) => void; // 방이 삭제됐다 (그 방에 있던 사람만 받는다)
  chatError: (text: string) => void;
}
