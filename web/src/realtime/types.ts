// 서버(server/realtime/types.ts)와 같은 이벤트 계약.
// 지금은 손으로 맞춰두고, 규모가 커지면 공용 패키지로 뺀다 (../types.ts 주석 참고).

interface ChatMessageBase {
  id: string;
  room: string;
  nickname: string;
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
}

// 클라이언트 → 서버
export interface ClientToServer {
  hello: (payload: { nickname: string }) => void;
  join: (payload: { room: string }) => void;
  leave: () => void;
  message: (payload: { text: string }) => void;
  // 이미지는 먼저 POST /api/chat/image로 올리고, 받은 id만 보낸다.
  image: (payload: { imageId: string }) => void;
  typing: () => void;
}

// 서버 → 클라이언트
export interface ServerToClient {
  rooms: (rooms: RoomSummary[]) => void;
  history: (messages: ChatMessage[]) => void;
  message: (message: ChatMessage) => void;
  presence: (users: string[]) => void;
  system: (text: string) => void;
  typing: (nickname: string) => void;
  chatError: (text: string) => void;
}
