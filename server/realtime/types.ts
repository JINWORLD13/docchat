// 서버와 클라이언트가 공유하는 실시간 채팅 이벤트 계약.
//
// Socket.IO를 타입으로 감싸면 "어떤 이벤트에 어떤 데이터가 오가는지"가 컴파일러로
// 강제된다. 오타나 잘못된 payload를 런타임 전에 잡는 게, 이 프로젝트를
// TypeScript로 옮긴 이유 중 가장 실질적인 부분이다.
//
// HTTP는 요청 하나에 응답 하나라 틀리면 그 자리에서 드러난다. 반면 소켓
// 이벤트는 이름이 문자열이라, 보내는 쪽이 "typing"을 "typeing"으로 써도
// 받는 쪽은 그냥 아무 일도 안 일어난다 — 에러조차 안 난다.
// 그래서 계약을 타입으로 못박는 이득이 HTTP보다 훨씬 크다.

interface ChatMessageBase {
  id: string;
  room: string;
  nickname: string; // 화면에 보이는 이름 (계정의 display_name)
  // 보낸 사람의 신원 — 이제 계정의 user id다(auth.ts). 화면은 이걸로 "내 것"을
  // 판단하고, 서버는 이걸로 취소 권한을 확인한다. 이름과 나눈 이유는 그대로다:
  // 보이는 이름은 흉내낼 수 있지만 로그인 세션은 흉내낼 수 없다.
  authorId: string;
  ts: number; // epoch ms
}

export interface TextMessage extends ChatMessageBase {
  kind: "text";
  text: string;
}

export interface ImageMessage extends ChatMessageBase {
  kind: "image";
  url: string; // 서버가 만든 주소. 클라이언트가 준 값을 그대로 싣지 않는다.
  width: number;
  height: number;
}

// kind로 갈리는 유니온. 화면에서 분기할 때 그 갈래에만 있는 필드
// (text / url)에 안전하게 접근할 수 있고, 종류를 하나 더 늘리면
// 처리를 빠뜨린 곳이 타입 검사에 걸린다.
export type ChatMessage = TextMessage | ImageMessage;

// 로비에 뿌리는 방 한 줄.
export interface RoomSummary {
  name: string;
  users: number;
  // 방을 만든 사람의 공개 신원. 이 값이 내 authorId와 같을 때만 삭제 버튼이
  // 보인다. 예전엔 방장 닉네임을 그대로 실어 보냈는데, 그러면 로비에 있는
  // 누구나 "저 방의 주인은 이 이름이다"를 알고 그 이름을 쓰면 그만이었다.
  ownerId: string;
}

// 클라이언트 → 서버 (서버가 듣는 이벤트)
//
// hello(닉네임 등록)가 없어진 이유: 신원이 소켓 이벤트가 아니라 로그인 세션에서
// 온다. 연결 자체가 인증이다 — 핸드셰이크의 세션 쿠키로 사용자를 확인하고
// (gateway.ts의 io.use), 실패하면 연결이 거절된다. 이름도 계정의 것을 쓴다.
export interface ClientToServer {
  join: (payload: { room: string }) => void; // 방 입장 (없으면 생성) / 방 이동
  leave: () => void; // 방만 나가고 로비로
  deleteRoom: (payload: { room: string }) => void; // 방 삭제 (방장만)
  message: (payload: { text: string }) => void;
  // 이미지는 먼저 HTTP로 올리고(POST /api/chat/image), 받은 id만 여기로 보낸다.
  // 바이트를 소켓에 실으면 방 인원수만큼 복제돼 나가고, 메모리에 든 최근 50개
  // 기록에도 사진이 통째로 쌓인다. 소켓은 작은 JSON만 나르게 둔다.
  image: (payload: { imageId: string }) => void;
  // 내가 보낸 것 취소. 이미지면 DB에 있는 바이트까지 지운다.
  deleteMessage: (payload: { messageId: string }) => void;
  typing: () => void;
}

// 서버 → 클라이언트 (서버가 보내는 이벤트)
// ("me" 이벤트가 없어진 이유: 내 신원은 이제 로그인 응답(/api/auth/me)이
//  알려준다. 화면은 거기서 받은 user id로 "내 것"을 판단한다.)
export interface ServerToClient {
  rooms: (rooms: RoomSummary[]) => void; // 방 목록 (바뀔 때마다 전원에게 push)
  history: (messages: ChatMessage[]) => void; // 입장 시 최근 기록
  message: (message: ChatMessage) => void; // 새 메시지 (방 전체에 브로드캐스트)
  messageDeleted: (messageId: string) => void; // 보낸 사람이 취소했다 (방 전체)
  presence: (users: string[]) => void; // 현재 방의 접속자 닉네임 목록
  system: (text: string) => void; // 입장/퇴장 같은 시스템 알림
  typing: (nickname: string) => void; // 누가 입력 중
  roomClosed: (room: string) => void; // 방이 삭제됐다 (그 방에 있던 사람만 받는다)
  chatError: (text: string) => void; // 사용자에게 보여줄 오류 (예: 도배 제한)
}

// 소켓 하나에 붙여두는 데이터.
// user는 핸드셰이크 미들웨어(gateway.ts의 io.use)가 세션에서 꺼내 채운다.
// 타입상 optional인 이유는 미들웨어 전에는 비어 있기 때문일 뿐, 연결이
// 수립된 소켓에는 언제나 있다.
export interface SocketData {
  user?: { id: string; displayName: string };
  room?: string;
}

// 대시보드에 노출하는 실시간 채팅 상태.
export interface RealtimeStats {
  rooms: number;
  users: number;
  messagesRejected: number; // 도배 제한에 걸린 누적 메시지 수
}
