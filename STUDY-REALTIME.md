# 실시간 채팅 공부 노트

DocChat 안의 실시간 채팅(Socket.IO) 부분만 따로 정리한 노트.
이 노트만 보고 백지에서 다시 칠 수 있게 만든 문서다. 코드는 실제 파일과 대조해 확인했다.

문서 Q&A 쪽 노트는 [STUDY.md](STUDY.md), 부하·장애 대응 설계는 [RELIABILITY.md](RELIABILITY.md)에 있다.

순서: 기획 → 지도 → 만드는 순서 → 흐름별 코드(주석) → 원리 → 헷갈리는 것 → 검색할 것 → 자가 점검.

---

# 0. 기획 — 코드 치기 전에 정하는 순서

무슨 문제를 푸나
  여러 명이 실시간으로 대화. 일반 HTTP는 "클라가 물어봐야 서버가 답하는" 구조라,
  서버가 먼저 밀어주는(다른 사람 메시지를 즉시 전달) 게 안 된다. 그래서 WebSocket.

사용 시나리오
  1) 닉네임을 정하고 로비 진입 2) 방 목록에서 고르거나 새 방을 만들어 입장
  3) 메시지 치면 방 전체에 즉시 뜸 4) 접속자 목록이 실시간 5) 나가면 알림.
  여기서 필요한 이벤트가 나온다:
  hello, rooms, join, leave, message, presence, typing, disconnect.

왜 닉네임과 방을 한 번에 안 받나
  방을 고르려면 어떤 방이 있는지 봐야 하고, 방 목록을 받으려면 이미 소켓이
  붙어 있어야 한다. 그래서 접속을 두 단계로 나눴다 — hello로 닉네임만 등록해
  로비에 들어가고, 목록을 본 뒤 join으로 방에 들어간다.
  방을 미리 만드는 절차는 따로 두지 않았다. 없는 이름으로 join하면 그 자리에서
  생긴다. "생성"과 "입장"이 같은 동작인 셈이다.

안 할 것 (스코프)
  로그인(닉네임만), 영구 저장(지금은 메모리), 멀티서버(지금은 1대),
  1:1 DM 전용(두 명짜리 방으로 대체).

데이터 흐름 두 줄 (나침반)
  서버: 이벤트 받음 → 방 상태 갱신 → 방 전체에 emit (+ 방 목록은 전원에게)
  클라: 소켓 연결 → 이벤트 구독 → 화면 갱신 (입력하면 → emit)

뭘 저장할지
  방마다 { 최근 메시지 50개, 접속자 map(socketId→닉네임) }. 서버 메모리.
  방 목록은 따로 들고 있지 않고 이 map에서 그때그때 만들어 낸다 —
  같은 사실을 두 군데 저장하면 반드시 어긋난다.

기술 선택 (제약에서 출발)
  실시간 양방향 → WebSocket. 직접 ws 다루는 대신 Socket.IO(재연결·방(room) 기능
  내장). 이벤트 payload 오타를 컴파일 때 잡으려고 TypeScript. 화면은 React.

만드는 순서 (줄기 먼저)
  서버 소켓 뜨기 → 방 상태 → join/message 핸들러 → 클라 두 탭으로 왕복 확인
  → presence·typing·도배 제한 얹기.

완료 기준
  두 탭이 같은 방에서 실시간으로 대화되고, 접속자 수가 뜨고, 입/퇴장 알림이 뜬다.

---

# 0-1. 왜 DocChat 안에 넣었나 (별도 서버가 아니라)

처음엔 별도 프로젝트로 만들었다가 DocChat에 합쳤다. 합치면서 정리한 판단이다.

DocChat엔 이미 "실시간"이 하나 있다 — 답변 토큰을 흘려보내는 SSE. 이름은 같지만
필요한 게 다르다.

| | 문서 Q&A 답변 | 실시간 채팅 |
|---|---|---|
| 방향 | 서버 → 클라 한 방향 | 양방향 |
| 대상 | 요청한 사람 1명 | 방 전체 (1:N) |
| 전송 | SSE (HTTP 그대로) | WebSocket |
| 왜 | 토큰이 순서대로 가기만 하면 됨. HTTP라 프록시·재연결이 공짜 | 보내는 쪽도 실시간. SSE면 전송마다 별도 POST가 필요 |

전송 방식이 다르다는 게 서버를 나눌 이유는 아니다. 한 프로세스에 두면:

- 포트·배포·CORS가 하나로 유지된다 (`createServer(app)` 하나에 Express와 Socket.IO를 같이 얹는다)
- 방어 로직을 공유한다 — 실제로 합치고 나서 HTTP rate limiter와 소켓 도배 제한이
  같은 Token Bucket을 각자 복사해 갖고 있는 게 드러나서, `server/tokenbucket.ts`
  하나로 뽑아냈다. 값(용량·충전 속도)만 용도별로 다르게 준다.
- 대시보드가 두 경로를 한 화면에서 본다 (`/api/metrics`에 realtime 항목 추가)

나눠야 할 때는 따로 있다: 채팅 트래픽과 Q&A 트래픽의 규모가 크게 달라져서
독립적으로 스케일해야 할 때. 지금은 그 시점이 아니라 한 프로세스가 맞다.

---

# 1. 전체 지도

| 칸 | 하는 일 | 파일 |
|---|---|---|
| S0 | Socket.IO를 기존 HTTP 서버에 붙이기 | server/realtime/gateway.ts |
| S1 | 방 상태(메시지·접속자) 메모리 + 방 목록 | server/realtime/rooms.ts |
| S2 | 소켓별 도배 제한 | server/realtime/ratelimit.ts |
| S3 | Token Bucket 알고리즘 (HTTP와 공용) | server/tokenbucket.ts |
| T | 이벤트 계약(타입) | server/realtime/types.ts (web와 짝) |
| E0 | 닉네임 등록 → 로비 (hello) | server/realtime/gateway.ts |
| E1 | 방 입장·이동 (join) — 없으면 생성 | server/realtime/gateway.ts |
| E2 | 메시지 (message) → 방에 브로드캐스트 | server/realtime/gateway.ts |
| E3 | 입력 중 (typing) | server/realtime/gateway.ts |
| E4 | 방 나가기 (leave) → 로비로 | server/realtime/gateway.ts |
| E5 | 연결 종료 (disconnect) | server/realtime/gateway.ts |
| C0 | 타입 있는 소켓 | web/src/realtime/socket.ts |
| C1 | 소켓 연결 관리 + 화면 전환 | web/src/realtime/LiveChat.tsx |
| C2 | 닉네임 입력 | web/src/realtime/Nickname.tsx |
| C3 | 방 목록 + 새 방 만들기 | web/src/realtime/RoomList.tsx |
| C4 | 대화창 (구독·전송) | web/src/realtime/Room.tsx |

S = 서버 준비, E = 이벤트 핸들러, C = 클라이언트.

화면은 세 단계다: 닉네임 입력 → 로비(방 목록) → 방 안.
소켓 연결은 C1(LiveChat)이 들고 있고, C4(Room)는 "이 방에 관한 이벤트"만 구독한다.
연결을 Room이 들고 있으면 방을 나갈 때마다 끊겼다 붙어서, 로비에 있는 동안
방 목록이 실시간으로 안 들어온다.

---

# 2. 만드는 순서

| 순서 | 만드는 것 | 왜 이때 | 켜보기(성공 신호) |
|---|---|---|---|
| 1 | types.ts (이벤트 계약) | 이후 emit/on을 타입으로 잡으려고 | tsc 통과? |
| 2 | rooms.ts (메모리 상태 + 목록) | 순수 로직, 의존성 0 | `node --test` 통과? |
| 3 | gateway.ts + index.ts에 붙이기 | 소켓 서버가 떠야 나머지가 붙음 | 서버 로그에 /socket.io? |
| 4 | hello / join / message 핸들러 | 줄기의 심장 | 두 탭에서 메시지 왕복? |
| 5 | 클라 socket.ts + LiveChat + Room | 화면에서 실제로 | 두 탭 실시간 대화? |
| 6 | rooms 브로드캐스트 + RoomList | 로비가 살아나는 지점 | 다른 탭이 만든 방이 뜸? |
| 7 | presence · typing · 도배 제한 | 가지, 하나씩 | 접속자 수/입력중 뜸? |

4번까지가 줄기다. 두 탭에서 메시지가 왕복하면 핵심은 끝.
방 목록(6번)은 없어도 채팅이 되므로 나중에 얹는다 — 방 이름을 코드에 박아두고
4~5번을 먼저 확인하는 게 빠르다.

준비물 (DocChat에 얹는 기준):

```bash
cd docchat/server && npm install socket.io
cd ../web && npm install socket.io-client
```

TypeScript 설정은 이미 DocChat 것을 쓴다. 서버는 빌드 단계 없이 Node가 타입을
벗겨서 바로 실행하므로(`node index.ts`), 상대 import에 **`.ts` 확장자**를 붙인다.
(`./rooms.js`가 아니라 `./rooms.ts` — Node는 `.js`를 `.ts`로 바꿔 찾아주지 않는다.)

---

# 3. 서버 흐름 (S · E)

## S0. Socket.IO를 기존 HTTP 서버에 붙이기

상황: Express 앱은 이미 있다. 그걸 감싼 http 서버에 Socket.IO를 얹는다.
파일: server/index.ts + server/realtime/gateway.ts

```ts
// index.ts — Express가 직접 listen하지 않는 이유가 여기 있다.
// Socket.IO는 express app이 아니라 그걸 감싼 http 서버에 붙는다.
const httpServer = createServer(app);
attachRealtime(httpServer);          // 같은 포트에서 HTTP와 WebSocket을 함께 받는다
httpServer.listen(port, ...);
```

```ts
// gateway.ts — 제네릭으로 이벤트 계약을 못박는다.
// 순서: <서버가 듣는 이벤트, 서버가 보내는 이벤트, 서버간 이벤트, 소켓 데이터>
// 이제 socket.on("join"...) / io.emit("message"...) 의 이름·payload가 타입 체크된다.
export type ChatServer = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export function attachRealtime(httpServer: HttpServer): ChatServer {
  const io: ChatServer = new Server(httpServer, { cors: { origin: "*" } });
  io.on("connection", (socket) => { /* E1~E4 */ });
  return io;
}
```

## S1. 방 상태 (메모리)

상황: 방마다 메시지와 접속자를 들고 있어야 브로드캐스트/presence가 된다.
파일: server/realtime/rooms.ts

```ts
const MAX_HISTORY = 50; // 방마다 최근 50개만

interface RoomState {
  messages: ChatMessage[];
  users: Map<string, string>; // socketId -> nickname
}
const rooms = new Map<string, RoomState>();

function getRoom(room: string): RoomState {
  let state = rooms.get(room);
  if (!state) { state = { messages: [], users: new Map() }; rooms.set(room, state); }
  return state; // 없으면 만들어서 반환 (호출부가 항상 존재를 가정할 수 있게)
}

export function addUser(room: string, socketId: string, nickname: string): void {
  getRoom(room).users.set(socketId, nickname);
}
export function removeUser(room: string, socketId: string): void {
  const state = rooms.get(room);
  if (!state) return;
  state.users.delete(socketId);
  // 아무도 없고 기록도 없으면 방 자체를 치운다 (메모리 누수 방지)
  if (state.users.size === 0 && state.messages.length === 0) rooms.delete(room);
}
export function onlineUsers(room: string): string[] {
  return [...(rooms.get(room)?.users.values() ?? [])]; // 닉네임만 배열로
}
export function addMessage(m: ChatMessage): void {
  const s = getRoom(m.room);
  s.messages.push(m);
  if (s.messages.length > MAX_HISTORY) s.messages.shift(); // 오래된 것부터 버림
}
```

로비에 뿌릴 목록은 따로 저장하지 않고 이 Map에서 만들어 낸다.

```ts
export function roomList(): RoomSummary[] {
  return [...rooms.entries()]
    .map(([name, state]) => ({ name, users: state.users.size }))
    .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name)); // 붐비는 방 위로
}
```

목록을 별도 배열로 들고 있으면 입장·퇴장·방 삭제 세 군데에서 같이 고쳐야 하고,
한 군데만 빠뜨리면 "있다고 나오는데 들어가면 없는 방"이 생긴다. 사실은 한 곳에만.

데이터 모양: users = Map{ "소켓id"→"철수" } → onlineUsers() → ["지영","철수"]
           rooms = Map{ "general"→{...} } → roomList() → [{name:"general", users:2}]

이 파일은 순수 로직이라 소켓 서버 없이 단위 테스트가 된다 (`realtime/rooms.test.ts`).
실시간 기능에서 조용히 망가지는 곳이 여기다 — 접속자가 안 지워지거나(유령 사용자),
방이 안 치워져 메모리가 새는 것 둘 다 화면에는 한참 뒤에야 드러난다.

## E0. 닉네임 등록 → 로비 (hello)

상황: 소켓은 붙었고 아직 어느 방에도 속하지 않았다. 닉네임만 받고 목록을 준다.
파일: server/realtime/gateway.ts (io.on("connection") 안)

```ts
socket.on("hello", ({ nickname }) => {
  const nick = (nickname ?? "").trim().slice(0, MAX_NICK);
  if (!nick) { socket.emit("chatError", "닉네임을 입력해주세요."); return; }

  socket.data.nickname = nick;      // 소켓에 꼬리표처럼 붙여둠 (이후 계속 씀)
  socket.emit("rooms", roomList()); // 방금 들어온 사람에게만 현재 목록
});
```

방 목록은 로비에 있는 사람도 봐야 하므로, 방이 바뀔 때마다 특정 방이 아니라
**전원에게** 보낸다. 그래서 브로드캐스트를 함수로 빼뒀다.

```ts
const broadcastRooms = (): void => { io.emit("rooms", roomList()); };
// io.emit = 서버에 붙은 전원 (로비에 있는 사람 포함). io.to(room)이면 로비는 못 받는다.
```

## E1. 방 입장·이동 (join)

상황: 로비에서 방을 골랐다. 없는 이름이면 그 자리에서 만들어진다(= 방 생성).
이미 다른 방에 있었다면 먼저 거기서 빠져나온다(방 이동).
파일: server/realtime/gateway.ts

```ts
socket.on("join", ({ room }) => {
  const { nickname } = socket.data;   // hello에서 붙여둔 꼬리표
  if (!nickname) { socket.emit("chatError", "먼저 닉네임을 정해주세요."); return; }

  const roomName = (room ?? "").trim().slice(0, MAX_ROOM);
  if (!roomName) { socket.emit("chatError", "방 이름을 입력해주세요."); return; }

  // 같은 방을 또 join한 경우(현재 방을 다시 누르거나, StrictMode 이중 실행).
  // 상태는 안 건드리고 화면 채울 것만 다시 보낸다. 그냥 return하면
  // 재구독 직전에 도착한 history를 놓쳐 방이 빈 채로 보인다.
  if (roomName === socket.data.room) {
    socket.emit("history", history(roomName));
    socket.emit("presence", onlineUsers(roomName));
    return;                          // 입장 알림은 다시 안 보낸다 (중복으로 뜸)
  }

  leaveCurrentRoom(socket);          // 있던 방에서 먼저 나온다 (방 이동)

  socket.data.room = roomName;
  socket.join(roomName);             // Socket.IO의 "방"에 넣기 → 이 방에만 broadcast 가능
  addUser(roomName, socket.id, nickname);

  socket.emit("history", history(roomName));                    // 나에게만 최근 기록
  io.to(roomName).emit("presence", onlineUsers(roomName));      // 방 전체에 접속자 목록
  socket.to(roomName).emit("system", `${nickname} 님이 입장했어요`); // 나 빼고 알림
  broadcastRooms();                  // 방이 생겼거나 인원이 바뀌었다 → 전원에게
});
```

데이터 모양: 받음 {room:"general"} → 방 조인 + 나/방/전원 세 곳에 각각 emit

## E2. 메시지 (방에 브로드캐스트)

상황: 클라가 {text}만 보냄. 서버가 완성된 메시지로 만들어 방 전체에 뿌린다.
파일: server/realtime/gateway.ts

```ts
socket.on("message", ({ text }) => {
  const { nickname, room } = socket.data; // 입장 때 붙여둔 꼬리표
  if (!nickname || !room) return;         // 입장 전이면 무시

  const trimmed = (text ?? "").trim().slice(0, MAX_TEXT);
  if (!trimmed) return;

  if (!allowMessage(socket.id)) {         // 도배 제한 (S2)
    socket.emit("chatError", "너무 빨리 보내고 있어요. 잠시 후 다시 시도해주세요.");
    return;
  }

  const message: ChatMessage = {
    id: randomUUID(), room, nickname, text: trimmed, ts: Date.now(),
  };
  addMessage(message);                    // 메모리에 저장(최근 50)
  io.to(room).emit("message", message);   // 방에 있는 모두에게 (1:N 브로드캐스트)
});
```

데이터 모양: 받음 {text:"안녕"} → 만듦 {id,room,nickname,text,ts} → 방 전체로 emit

id와 ts를 클라가 아니라 서버가 붙이는 이유: 클라가 준 값은 못 믿는다(시계가 틀리거나
일부러 조작할 수 있다). 방 전체가 같은 기준을 보려면 한 곳에서 찍어야 한다.

## E4 · E5. 방 나가기 (leave) / 연결 종료 (disconnect)

상황: 둘 다 "방에서 빠진다"는 같은 일을 한다. 다른 건 소켓을 유지하느냐뿐이다.
leave는 로비로 돌아가는 것이고(목록은 계속 봐야 한다), disconnect는 탭을 닫은 것.
파일: server/realtime/gateway.ts

같은 일을 두 번 쓰지 않으려고 헬퍼로 뺐다. 방 이동(E1)에서도 이걸 쓴다.

```ts
// 지금 있는 방에서 빼낸다. 반환값은 "실제로 어딘가에서 나왔는지" —
// 로비에만 있던 소켓이 끊길 때 굳이 목록을 다시 뿌리지 않으려고.
const leaveCurrentRoom = (socket: ChatSocket): boolean => {
  const { nickname, room } = socket.data;
  if (!room) return false;

  removeUser(room, socket.id);
  socket.leave(room);                                 // Socket.IO 방에서 탈퇴
  io.to(room).emit("presence", onlineUsers(room));    // 갱신된 접속자
  if (nickname) socket.to(room).emit("system", `${nickname} 님이 나갔어요`);
  socket.data.room = undefined;
  return true;
};

socket.on("leave", () => {
  if (leaveCurrentRoom(socket)) broadcastRooms();     // 연결은 유지 → 로비
});

socket.on("disconnect", () => {
  if (leaveCurrentRoom(socket)) broadcastRooms();
  dropBucket(socket.id);                              // 도배 제한 버킷 정리
});
```

`socket.leave(room)`을 빼먹기 쉽다. 우리 rooms.ts에서 지워도 Socket.IO 내부의 방에는
그대로 남아 있어서, 로비로 나온 뒤에도 그 방 메시지를 계속 받는다.

## E6. 이미지 (HTTP 업로드 + 소켓으로 id만)

상황: 사진을 방에 보낸다. 바이트를 소켓에 싣지 않는 게 설계의 전부다.
파일: server/routes/images.ts (업로드·조회) + server/realtime/gateway.ts (브로드캐스트)

왜 소켓으로 안 보내나
  Socket.IO가 바이너리를 나르긴 한다. 그런데 방에 10명이 있으면 사진 한 장이
  10번 복제돼 나가고, 메모리에 든 최근 50개 기록에도 사진이 통째로 쌓인다.
  텍스트 50개는 몇 KB지만 사진 50장은 수십 MB다. 소켓은 작은 JSON만 나르게 둔다.

흐름
```
[클라] 파일 선택/붙여넣기/드롭
  → 원본 크기 측정 (createImageBitmap)
  → POST /api/chat/image (multipart)         ← HTTP, 쓰기 성격
[서버] 앞머리 바이트로 형식 판별 → DB에 bytea로 저장 → { id } 반환
[클라] socket.emit("image", { imageId })     ← 소켓엔 id만
[서버] id가 우리가 발급한 것인지 확인 → url을 서버가 만들어 방 전체에 broadcast
[각 클라] <img src={url}> → GET /api/chat/image/:id  ← 브라우저가 알아서, 캐시됨
```

```ts
socket.on("image", ({ imageId }) => {
  const { nickname, room } = socket.data;
  if (!nickname || !room) return;

  void (async () => {
    // 크기만 읽는다. 바이트는 브라우저가 url로 따로 받아가므로,
    // 메시지를 뿌릴 때마다 수백 KB를 DB에서 끌어올 이유가 없다.
    const meta = await describeImage(imageId);
    if (!meta) { socket.emit("chatError", "이미지를 찾을 수 없어요."); return; }

    publish((base) => ({ ...base, kind: "image", url: imageUrl(imageId), ...meta }));
  })();
  // async 핸들러라 안에서 안 잡으면 unhandled rejection으로 프로세스가 죽는다.
});
```

주소를 클라이언트에게 받지 않는 이유
  `url`을 payload로 받으면, 누군가 `https://evil.example.com/tracker.gif`를 보내
  그 방 사람들 브라우저가 전부 남의 서버로 요청을 보내게 만들 수 있다(IP 노출·추적).
  그래서 id만 받고 주소는 서버가 만든다. id가 실제로 발급된 것인지도 DB에서 확인한다.

형식을 파일명·Content-Type으로 안 믿는 이유
  둘 다 클라이언트가 적어 보내는 값이다. `evil.html`을 `cat.png`라는 이름에
  `image/png` 타입으로 올릴 수 있다. 우리는 이 바이트를 나중에 같은 오리진에서
  브라우저로 내려보내므로, 앞머리 서명을 직접 확인한다 (server/imagetype.ts).
  SVG는 아예 안 받는다 — XML이라 `<script>`가 들어가고, 이미지로 렌더링되면서
  그게 실행돼 저장형 XSS가 된다. 래스터만 받으면 이 문제가 통째로 사라진다.

## S2 · S3. 도배 제한 (소켓별 Token Bucket)

상황: 한 명이 초당 수십 개를 쏴서 방을 마비시키는 걸 막는다.
파일: server/realtime/ratelimit.ts (얇은 껍데기) + server/tokenbucket.ts (알고리즘)

```ts
// realtime/ratelimit.ts — 값만 정하고 알고리즘은 공용 모듈에 맡긴다
const buckets = new TokenBuckets(
  Number(process.env.CHAT_RL_CAPACITY || 5),  // 순간 최대 5개
  Number(process.env.CHAT_RL_REFILL || 2)     // 초당 2개 충전
);

export function allowMessage(socketId: string): boolean {
  return buckets.take(socketId).ok;
}
export function dropBucket(socketId: string): void {
  buckets.drop(socketId); // 연결이 끊기면 즉시 회수
}
```

HTTP 요청 제한(`server/ratelimit.ts`)도 같은 `TokenBuckets`를 쓴다. 값만 다르다
(HTTP는 10/5, 채팅은 5/2). 다른 이유: HTTP 질문은 한 건이 비싸고(임베딩+LLM) 드물게
오지만, 채팅 메시지는 싸고 자주 온다. 대신 채팅은 한 명의 도배가 방 전체 사람들
화면을 덮어버리므로 순간 버스트를 더 좁게 잡았다.

회수 방식도 다르다. 소켓은 disconnect라는 "끝났다" 신호가 명확해서 그 시점에
`drop()`으로 정확히 지운다. IP는 그런 신호가 없어서 주기적으로 유휴 버킷을
`sweep()`으로 훑어 내보낸다.

---

# 4. 클라이언트 흐름 (C)

## C0. 타입 있는 소켓

상황: 서버와 같은 계약을 쓰되, 방향이 반대다.
파일: web/src/realtime/socket.ts

```ts
import { io, type Socket } from "socket.io-client";
import type { ClientToServer, ServerToClient } from "./types";

// 클라 입장: 듣는 건 ServerToClient, 보내는 건 ClientToServer → 서버와 순서가 뒤바뀐다.
// io()에 주소를 안 주면 같은 오리진에 붙는다. 채팅 서버가 문서 Q&A와 같은
// 프로세스·같은 포트에 있고, 개발 중엔 Vite가 /socket.io를 그쪽으로 프록시한다.
export const socket: Socket<ServerToClient, ClientToServer> = io({
  autoConnect: false, // 탭에 들어가 방에 입장할 때 직접 connect()
});
```

프록시 설정 (web/vite.config.ts):

```ts
proxy: {
  "/api": "http://localhost:4000",
  // ws:true를 빼면 처음 polling 핸드셰이크만 되고 WebSocket 업그레이드에서
  // 조용히 실패해 계속 polling으로 돈다 (동작은 하는데 느려서 눈치채기 어렵다)
  "/socket.io": { target: "http://localhost:4000", ws: true },
}
```

## C1. 소켓 연결과 화면 전환

상황: 소켓 하나를 여기서 켜고 끈다. 방을 옮겨도 연결은 유지된다.
파일: web/src/realtime/LiveChat.tsx

```ts
useEffect(() => {
  if (!nickname) return;                 // 닉네임을 정하기 전엔 연결하지 않는다

  const onRooms = (list: RoomSummary[]) => setRooms(list);
  const onError = (text: string) => setError(text);

  socket.on("rooms", onRooms);
  socket.on("chatError", onError);
  socket.connect();
  socket.emit("hello", { nickname });    // 서버 E0으로 감 → 로비 진입

  return () => {
    socket.off("rooms", onRooms);
    socket.off("chatError", onError);
    socket.disconnect();
  };
}, [nickname]);
```

방을 고르면 `setRoom(name)`만 한다. 실제 join은 Room이 마운트되며 보낸다.
방을 나갈 땐 `socket.emit("leave")` 후 `setRoom(null)` — 연결은 그대로 두고
로비로 돌아간다.

```tsx
{room ? (
  // key={room}: 방을 옮기면 Room을 새로 마운트해 이전 방 메시지를 비운다.
  // key가 없으면 컴포넌트가 재사용되어 이전 대화가 남는다.
  <Room key={room} nickname={nickname} room={room} ... />
) : (
  <div className="live-empty">방을 고르거나 새로 만들어주세요.</div>
)}
```

## C4. 대화창 — 구독·전송

상황: 방에 들어오면 그 방 이벤트를 구독한다. 연결은 C1이 이미 해뒀다.
파일: web/src/realtime/Room.tsx

```ts
useEffect(() => {
  // 핸들러를 변수에 담아두고 off에 그대로 넘긴다. 이유는 아래 설명.
  const onHistory = (msgs: ChatMessage[]) =>
    setItems(msgs.map((msg) => ({ kind: "msg", msg })));
  const onMessage = (msg: ChatMessage) =>
    setItems((prev) => [...prev, { kind: "msg", msg }]);
  const onSystem = (text: string) => setItems((prev) => {
    // 연속 같은 시스템 알림은 하나만 (StrictMode 이중 실행 등 중복 대비)
    const last = prev[prev.length - 1];
    if (last && last.kind === "system" && last.text === text) return prev;
    return [...prev, { kind: "system", id: crypto.randomUUID(), text }];
  });
  const onPresence = (list: string[]) => setUsers(list);

  socket.on("history", onHistory);
  socket.on("message", onMessage);
  socket.on("system", onSystem);
  socket.on("presence", onPresence);

  // 구독을 먼저 걸고 입장을 알린다 — 순서가 반대면 서버가 즉시 돌려주는
  // history를 놓칠 수 있다.
  socket.emit("join", { room });

  return () => {
    socket.off("history", onHistory);    // 이름만 주면 남의 구독까지 지운다
    socket.off("message", onMessage);
    socket.off("system", onSystem);
    socket.off("presence", onPresence);
  };
}, [room]); // 방이 바뀌면 다시 구독 + 다시 join (연결은 안 끊는다)
```

```ts
// 전송: 서버로 텍스트만 보낸다. 완성된 메시지는 서버가 만들어 되돌려준다(E2).
function send(e: FormEvent) {
  e.preventDefault();
  const text = input.trim();
  if (!text) return;
  socket.emit("message", { text });
  setInput("");
}
```

데이터 모양: 내 입력 "안녕" → emit {text:"안녕"} → (서버) → on("message", 완성된 메시지)

---

# 5. 왜 그렇게 하나

| 무엇 | 왜 |
|---|---|
| HTTP 말고 WebSocket(Socket.IO) | HTTP는 클라가 물어야 답함. "남의 메시지를 즉시 밀어주기"가 안 됨 |
| 답변 스트리밍은 SSE인데 채팅은 WebSocket | 답변은 한 방향 1:1이라 SSE로 충분. 채팅은 양방향 1:N |
| 같은 서버·같은 포트 | 포트·배포·CORS가 하나로 유지되고 방어 로직(Token Bucket)을 공유 |
| 접속을 hello/join 두 단계로 | 방을 고르려면 목록을 봐야 하고, 목록을 받으려면 소켓이 먼저 붙어야 함 |
| 방 생성 = 없는 이름으로 join | 별도 생성 절차를 두면 아무도 없는 빈 방을 정리할 방법이 없음 |
| 방 목록은 io.emit | 로비에 있는 사람(어느 방에도 없음)도 받아야 하니까. io.to(room)이면 못 받음 |
| 방 목록을 저장 안 하고 계산 | 입장·퇴장·삭제 세 군데를 같이 못 고치면 "있는데 없는 방"이 생김 |
| 소켓 연결은 LiveChat이 소유 | Room이 들고 있으면 방을 나갈 때마다 끊겨서 로비에서 목록이 안 옴 |
| socket.join(room) + io.to(room) | 그 방에 있는 사람에게만 뿌리려고. 전체(io.emit)면 다른 방까지 감 |
| socket.data에 닉/방 저장 | message·disconnect 때 "이 소켓이 누구/어느 방"인지 다시 알아야 하니까 |
| 이벤트를 타입으로 | emit/on 이름·payload 오타를 런타임 전(컴파일)에 잡으려고 |
| 지금은 메모리 저장 | MVP 줄기. 서버 죽으면 날아감 → 다음 단계에서 Postgres로 durability |
| cleanup에서 핸들러까지 지정해 off | 이름만 주면 같은 이벤트를 듣는 다른 컴포넌트 구독까지 지움 |

---

# 6. 헷갈리는 것

## emit 4형제 — 누구에게 가나

| 코드 | 받는 사람 |
|---|---|
| `io.emit(...)` | 서버에 붙은 전원 (모든 방) |
| `socket.emit(...)` | 그 소켓 한 명 (나 자신) |
| `io.to(room).emit(...)` | 그 방의 전원 (나 포함) |
| `socket.to(room).emit(...)` | 그 방에서 나를 뺀 전원 |

입장 알림을 `socket.to(room)`으로 보내는 이유: 나한테 "내가 입장했어요"는 필요 없으니까.
접속자 목록은 `io.to(room)`으로: 나도 최신 목록을 받아야 하니까.
방 목록은 `io.emit`으로: 로비에 있는 사람은 어느 방에도 속해 있지 않아서,
`io.to(room)`으로는 절대 닿지 않는다.

## socket.off — 이름만 주면 전부 지운다

```ts
socket.off("message");            // 이 이벤트를 듣는 리스너를 "전부" 제거
socket.off("message", onMessage); // 내가 건 것만 제거
```

컴포넌트 하나만 소켓을 들을 땐 차이가 없다. 그런데 LiveChat(방 목록)과
Room(대화)이 같이 듣게 되면서 문제가 생겼다. Room이 언마운트하며
`socket.off("chatError")`를 부르면 LiveChat의 에러 구독까지 같이 날아간다.
그때부터는 도배 제한에 걸려도 화면에 아무것도 안 뜬다 — 에러도 안 나고
그냥 조용해지는 종류의 버그다.

## 이벤트 타입 방향 — 서버와 클라가 반대

```
서버:  Server<ClientToServer, ServerToClient, ...>   (듣는 것, 보내는 것)
클라:  Socket<ServerToClient, ClientToServer>          (듣는 것, 보내는 것)
```
서버가 "듣는" 이벤트(join, message)는 클라가 "보내는" 이벤트다. 그래서 순서가 뒤집힌다.
헷갈리면 "나는 무엇을 듣나"를 먼저 놓는다고 외운다.

## 이벤트 이름은 타입으로만 잡힌다

HTTP는 요청 하나에 응답 하나라, 경로를 틀리면 404가 바로 온다. 소켓 이벤트는
이름이 문자열이라 보내는 쪽이 `"typing"`을 `"typeing"`으로 써도 받는 쪽은 그냥
아무 일도 안 일어난다 — 에러조차 안 난다. 그래서 계약을 타입으로 못박는 이득이
HTTP보다 훨씬 크다. 이 프로젝트를 TypeScript로 옮긴 가장 실질적인 이유.

## StrictMode 이중 실행

개발 모드에서 React는 useEffect를 일부러 두 번 실행한다(cleanup까지). 그래서
connect→disconnect→connect가 일어나 "입장" 시스템 메시지가 두 번 올 수 있다.
프로덕션 빌드에선 안 그런다. 그래서 연속 중복 시스템 메시지를 걸러 처리했다.

## Vite 프록시의 ws:true

없어도 채팅이 "된다". Socket.IO가 polling으로 떨어져서 동작하기 때문이다.
그래서 빠뜨려도 눈치채기 어렵고, WebSocket을 쓴다고 생각하면서 실제로는
polling으로 도는 상태가 된다. 개발자도구 Network에서 transport를 확인할 것.

---

# 7. 검색해서 쓸 것 (외우지 말 것)

| 항목 | 이유 |
|---|---|
| createServer + Socket.IO 붙이기 | 셋업 패턴, 한 번 쓰고 안 건드림 |
| Socket.IO Server/Socket 옵션 (cors 등) | 문서 보고 |
| socket.io-client io() 옵션 | 검색 |
| Vite proxy ws 옵션 | 검색 |
| React useEffect 구독/정리 패턴 | 리액트 기본 |

---

# 8. 자가 점검

백지에 이것만 되면 칠 수 있다.

1. 왜 HTTP가 아니라 WebSocket인가 (서버가 먼저 못 민다)
2. 같은 앱의 답변 스트리밍은 왜 SSE로 두는가 (한 방향 1:1이라 충분)
3. 접속을 왜 hello / join 두 단계로 나눴나
4. 방 "생성"이 왜 별도 이벤트가 아닌가 (없는 이름으로 join = 생성)
5. 방 목록을 왜 io.emit으로 보내나 (로비 사람은 어느 방에도 없다)
6. 방 목록을 왜 따로 저장하지 않나 (한 사실을 두 곳에 두면 어긋난다)
7. Socket.IO 제네릭 4칸 순서를 말할 수 있나 (듣는·보내는·서버간·데이터)
8. `io.to(room)` vs `socket.to(room)` 차이 (나 포함/제외)
9. socket.data에 닉/방을 왜 저장하나 (message·disconnect에서 다시 필요)
10. join 핸들러가 세 곳(나·방전체·방(나 제외))에 각각 뭘 보내는지
11. leave와 disconnect가 뭐가 같고 뭐가 다른가 (방 탈퇴는 같고, 소켓 유지가 다름)
12. `socket.leave(room)`을 빼먹으면 무슨 일이 생기나
13. message는 클라가 {text}만 보내는데 왜 서버가 id·ts를 붙이나 (신뢰·일관성)
14. `socket.off("x")`와 `socket.off("x", handler)`의 차이가 왜 중요해졌나
15. 소켓 연결을 왜 Room이 아니라 LiveChat이 들고 있나
16. `<Room key={room}>`의 key가 왜 필요한가 (이전 방 메시지가 남는다)
17. 클라 소켓 타입이 서버와 왜 순서가 반대인가
18. 지금 메시지는 어디 저장되고, 서버가 죽으면 어떻게 되나 (메모리, 날아감 → 로드맵)
19. 도배 제한이 어디서 동작하나 (message 핸들러, 소켓별 Token Bucket)
20. HTTP 제한과 소켓 제한이 같은 구현을 쓰는데 값이 왜 다른가
21. 소켓 버킷은 drop, IP 버킷은 sweep으로 회수하는 이유
