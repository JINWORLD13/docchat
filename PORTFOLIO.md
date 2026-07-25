**한국어** | [日本語](PORTFOLIO.ja.md)

# DocChat

문서를 업로드하면 그 문서 내용만 근거로 답하는 RAG 챗봇.
문서에 없는 질문은 지어내지 않고 거절하며, 답변마다 근거 출처를 표시한다.
여러 명이 같은 방에서 대화하는 실시간 채팅을 같은 서버에 함께 얹었다.

- 저장소: https://github.com/JINWORLD13/docchat
- 스택: TypeScript · React (Vite) · Node/Express · PostgreSQL + pgvector ·
  Socket.IO · Gemini API
- 로컬 실행: 아래 [실행](#실행) 세 단계

---

## 데모

### 답변은 항상 근거와 함께

![답변과 근거 출처](docs/demo-answer.png)

질문을 던지면 참고한 문서와 유사도(0.75, 0.67)가 먼저 뜨고, 그 아래로 답변이
한 글자씩 흐른다. 문장 끝의 [1], [2]는 위 출처 번호와 그대로 연결된다.
입력·출력 토큰도 함께 남겨 비용을 추적한다.

### 문서에 없으면 지어내지 않는다

![문서에 없으면 거절](docs/demo-refusal.png)

검색 최고 유사도가 임계값(0.62) 아래면 거절한다. 이때 LLM은 **호출조차 하지 않는다** —
헛소리를 막는 동시에 토큰과 지연을 아낀다.

### 부하·장애 대응 대시보드

방어 로직이 "언제 발동했는지" 눈으로 볼 수 없으면 장애 상황에서 판단할 수 없다.
그래서 상황을 버튼으로 주입하고 반응을 실시간으로 관찰하는 화면을 만들었다.

![정상 부하](docs/demo-dashboard-burst.png)

동시 20건을 쏘면 Rate Limiter가 버킷에 남은 토큰을 넘는 요청을 429로 막는다
(정상 17, 거절 3). 회로는 닫힌 채 서비스는 정상.

버킷 용량이 10이니 산술적으로는 10건이 막혀야 하는데 3건만 막혔다. 브라우저가 한
오리진에 동시 연결을 6개(HTTP/1.1)까지만 열어서, 20건이 한꺼번에 나가지 못하고 약
2초에 걸쳐 흘러나갔기 때문이다. 그사이 토큰이 초당 5개씩 다시 차서 대부분이 통과했다.
이론값과 측정값이 갈리는 지점이라 적어둔다 — 부하를 무엇으로 거느냐가 곧 측정 조건이다.
브라우저를 거치지 않는 `MODE=burst node scripts/demo-defense.ts`는 같은 제한에서
이론값에 가까운 거절 수를 낸다.

![LLM 장애 주입](docs/demo-dashboard-breaker.png)

LLM 장애를 주입하면 연속 실패가 쌓여 Circuit Breaker가 열리고(빨강), 이후 요청은
LLM을 부르지도 않고 degraded(출처만)로 응답한다. **20건 중 하드 에러는 0** —
사용자는 답변 요약만 잃고 관련 문서는 그대로 받는다.

설계 근거와 측정값은 [RELIABILITY.md](RELIABILITY.md)에 정리했다.

---

## 아키텍처

```
  브라우저 (React)
     │  질문 (POST, SSE로 응답 수신) · 채팅 (WebSocket) · 이미지 (POST → id)
     ▼
  Express 서버 + Socket.IO  (한 프로세스 · 같은 포트 4000)
     │
     ├─ 채팅: 소켓 → 도배 제한(Token Bucket) → 같은 방에 브로드캐스트
     │
     ├─ 이미지: HTTP 업로드 → 앞머리 바이트로 형식 판별(SVG 제외) → 저장
     │          소켓엔 id만 · 주소는 서버가 생성 · 조회는 전용 풀(mediaPool)
     │                                  │
     ├─ 넣기: 파일 → 청킹(겹침) → 임베딩 → 저장
     │                                  │
     │                                  ▼
     │                         PostgreSQL + pgvector
     │                         (문서 · 조각+벡터 · 질문로그 · 채팅 이미지)
     │                                  ▲
     └─ 묻기: 질문 → 임베딩 → 벡터 검색 top5
                                │
                                ├─ 유사도 < 0.62 → 거절 (LLM 호출 안 함)
                                │
                                └─ 통과 → 발췌를 프롬프트에 넣고 생성
                                              │
                                              ▼
                                     Gemini API (생성, 스트리밍)
```

문서 Q&A의 핵심은 두 흐름이다. 문서를 넣는 흐름(청킹 → 임베딩 → 저장)과
질문하는 흐름(검색 → 거절 판단 → 생성). 생성 호출은 맨 마지막 한 조각일 뿐이고,
그 앞의 검색과 거절이 이 프로젝트의 본체다. 채팅은 전송 방식만 다를 뿐 같은
프로세스에 얹혀 있고, rate limit 같은 방어 로직을 문서 Q&A와 공유한다.

---

## 기술 선택과 이유

검색 저장소로 pgvector.
전용 벡터DB(Pinecone 등)를 붙이면 인프라가 하나 늘고, 문서 메타데이터는
Postgres·벡터는 별도 DB로 나뉘어 동기화가 번거롭다. pgvector는 Postgres에
vector 컬럼 하나를 더하는 것이라, 메타데이터 조인과 벡터 검색이 SQL 한 번에
끝난다. 개인·중소 규모에는 이쪽이 단순하다.

겹치는 청킹.
문서를 어절 200개 단위로 자르되 40개씩 겹친다. 겹치지 않으면 "환불은 3~5일
걸린다" 같은 문장이 조각 경계에서 반으로 잘려, 어느 조각도 온전한 답을 갖지
못한다. 겹침은 경계에 걸린 문장을 살리는 보험이다.

유사도 임계값으로 거절.
관련 없는 발췌를 억지로 넣고 생성하면 그럴듯한 헛소리가 나온다. 그래서 검색
최고 유사도가 임계값 미만이면 LLM을 호출하지 않고 거절한다. 헛소리를 막고
토큰도 아낀다.

답변은 SSE, 채팅은 WebSocket.
한 앱에 "실시간"이 둘인데 성격이 다르다. 답변 토큰은 서버에서 클라이언트로 흐르는
단방향 1:1이라 SSE로 충분하다 — HTTP 위에서 그대로 동작하니 프록시와 재연결이
공짜다. 반면 채팅은 양방향이고 한 사람의 발화를 방 전체(1:N)에 밀어줘야 해서
WebSocket이 맞다. 전송 방식은 취향이 아니라 필요한 방향이 갈랐다.

그래도 서버는 나누지 않았다.
전송 방식이 다른 것과 프로세스를 나눌 이유가 있는 것은 다른 얘기다. 같은 Express
HTTP 서버 하나에 Socket.IO를 붙여 포트·배포·CORS를 하나로 유지했고, 방어 로직도
공유한다. 합치고 나서야 중복이 드러났다 — HTTP 요청 제한과 채팅 도배 제한이 같은
Token Bucket을 각자 복사해 갖고 있었다. 이걸 server/tokenbucket.ts 하나로 뽑아
양쪽이 공유하고 값만 다르게 준다(HTTP는 용량 10·초당 5개 충전, 채팅은 5·2).
나눠야 할 때는 두 트래픽의 규모가 크게 달라져 각각 독립적으로 스케일해야 할 때다.

버킷의 키를 socket.id로 잡았다가 갈아엎었다.
처음엔 채팅 버킷을 소켓별로 두고, disconnect 때 `drop()`으로 정확히 회수하는 게
IP 기반보다 깔끔하다고 생각했다. 실제로 회수는 깔끔했는데, 제한이 아무것도 막지
못했다 — socket.id는 연결할 때마다 새로 생기므로 "5발 쏘고 끊고 다시 붙으면"
매번 새 버킷을 만땅으로 받는다. 제한이 도배 속도가 아니라 재연결 속도에만
걸려 있었던 셈이다. 그래서 키를 재연결해도 따라오는 값(IP)으로 바꾸고, IP당
살아 있는 소켓 수를 세어 마지막 하나가 끊길 때 회수하도록 했다. 정확한 회수는
그대로 얻으면서 우회는 막힌다. 여기에 IP당 동시 연결 상한을 더해, 연결을 여러 개
여는 방식으로 제한을 곱하는 길도 닫았다.

정리하면 회수 신호가 있느냐 없느냐가 방식을 가른다 — 소켓은 disconnect라는
명확한 신호가 있어 그 시점에 `drop()`하고, HTTP의 IP는 그런 신호가 없어 주기적
`sweep()`으로 유휴 버킷을 청소한다. 다만 "무엇을 키로 삼을지"는 그와 별개로,
공격자가 바꿀 수 있는 값인지로 정해야 한다는 걸 이때 배웠다.

이미지는 내용으로 판별하고, SVG는 아예 받지 않는다.
채팅에 올라온 이미지의 형식을 파일명이나 Content-Type으로 정하지 않는다. 둘 다
클라이언트가 적어 보내는 값이라, `evil.html`을 `cat.png`라는 이름에 `image/png` 타입으로
실어 보낼 수 있다. 그래서 업로드된 바이트 앞머리의 고정 서명(magic bytes)을 직접 읽어
png·jpg·gif·webp만 통과시킨다(server/imagetype.ts). 확장자도 그 판별 결과에서 나온다.
허용 목록에서 SVG를 일부러 뺀 것도 같은 판단이다 — SVG는 XML이라 `<script>`가 들어가고,
우리가 그 파일을 나중에 같은 오리진에서 브라우저로 내려보내는 순간 저장형 XSS가 된다.
래스터 포맷만 받으면 이 문제가 통째로 사라지고, magic bytes로 거르는 방식과도 맞는다
(SVG에는 고정 서명이 없다). 응답에는 `X-Content-Type-Options: nosniff`를 같이 보내,
브라우저가 우리가 정한 타입을 무시하고 내용을 훑어 다시 판단하는 길도 막는다.
판별기를 순수 함수로 떼어놓은 덕에 "거절해야 할 것을 거절하는가"를 단위 테스트 8개로
고정할 수 있었다.

바이트는 소켓에 싣지 않고, 주소는 서버가 만든다.
이미지는 HTTP로 먼저 올리고(POST /api/chat/image) 소켓에는 발급받은 id만 보낸다. 소켓에
바이트를 실으면 사진 한 장이 방 인원수만큼 복제돼 나가고, 메모리에 든 최근 50개 기록에도
사진이 통째로 쌓인다. 업로드가 URL이 아니라 id만 돌려주는 것도 의도한 것이다 —
클라이언트가 URL을 정할 수 있으면 `https://evil.example.com/tracker.gif` 같은 주소를 방
전체에 뿌려 그 방 사람들 브라우저가 남의 서버로 요청을 보내게 만들 수 있다. 서버는 받은
id가 자기가 발급한 것인지 확인한 뒤에야 주소를 붙인다. 저장은 Postgres `chat_images`에
bytea로 하고, 조회는 읽기 풀이 아니라 전용 풀(mediaPool)로 격리했다. 이미지 조회는
메시지가 화면에 뜰 때마다 나가는 잦고 무거운 읽기라, 질문 검색용 읽기 풀에 태우면
사진 많은 방 하나가 이 프로젝트가 "사수하겠다"고 말한 경로를 굶기기 때문이다.

TypeScript, 빌드 단계 없이.
서버·프런트를 전부 TypeScript로 옮기되 빌드 산출물은 만들지 않았다. Node 24가
실행할 때 타입만 벗겨내므로(type stripping) `node index.ts`로 바로 돌고, `tsc`는
`npm run typecheck`에서 검사만 한다(noEmit). dist/도, tsx 같은 별도 런타임도 없다.
대가는 상대 import에 실제 파일 이름을 그대로 써야 한다는 것(`./db.ts`) — Node는
`./db.js`를 db.ts로 바꿔 찾아주지 않는다. 프런트는 Vite가 번들해야 하므로
`tsc -b && vite build`로 빌드한다.

옮겨서 실제로 얻은 것.
추상적인 안전성 말고 두 가지가 잡혔다. 하나, `/api/metrics` 응답 모양을
server/types.ts의 `MetricsResponse` 한 곳에 두고 서버·측정 스크립트·대시보드가
공유하게 했더니, Bulkhead로 DB 풀을 읽기/쓰기로 쪼갠 뒤 부하 측정 스크립트가
사라진 `m.pool.total`을 계속 읽고 있던 게 컴파일에서 드러났다. JS일 때는 화면에
undefined가 찍힐 뿐 아무도 몰랐다. 둘, 소켓 이벤트 계약을 제네릭 타입으로
못박았다. HTTP는 경로를 틀리면 404가 돌아오지만 소켓 이벤트는 이름이 문자열이라
`"typing"`을 `"typeing"`으로 써도 에러조차 안 나고 조용히 아무 일도 일어나지
않는다. 그래서 타입으로 잡는 이득이 HTTP 쪽보다 크다.

---

## 부딪힌 문제와 해결

### 1. 거절 임계값을 감이 아니라 데이터로 정했다

처음엔 임계값을 0.5로 잡았는데, "프랑스 수도?" 같은 무관한 질문도 유사도가
0.53으로 나와 게이트를 통과해버렸다.

감으로 올리는 대신, 샘플 문서에 관련 질문 5개와 무관한 질문 4개를 실제로
던져 유사도를 측정했다.

```
관련 질문   0.662 ~ 0.744
무관 질문   0.527 ~ 0.587
```

두 분포 사이에 뚜렷한 갭이 있어 그 중간인 0.62로 정했다. 그리고 이 값을
하드코딩하지 않고 환경변수로 빼서, 질문마다 query_logs에 남는 유사도를 보고
다시 맞출 수 있게 했다.

### 2. 외부 API의 일시적 오류를 재시도로 견뎠다

개발 중 임베딩 API가 503(일시적 서비스 불가)을 뱉어 답변이 실패하는 걸 봤다.
일시적 오류(429, 5xx)만 지수 백오프로 재시도하고, 400·404처럼 재시도해도
소용없는 오류는 바로 실패시키도록 나눴다.

```ts
const RETRYABLE = new Set([429, 500, 503, 504]);

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000];        // 0.5s → 1s → 2s
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const wait = delays[attempt];        // 없으면 = 재시도를 다 썼다
      if (!RETRYABLE.has(statusOf(e)) || wait === undefined) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
```

---

## 측정한 지표

실사용자 지표는 없다(개인 데모). 대신 직접 측정한 값들이다.

응답 속도 (query_logs 기록 기준)

| 경우 | 걸린 시간 | 비고 |
|---|---|---|
| 거절 (문서에 없는 질문) | 약 0.5초 | 임베딩+검색만, LLM 호출 안 함 |
| 답변 | 약 3~8초 | 임베딩+검색+생성 전체. 스트리밍이라 첫 글자는 더 빨리 뜸 |

토큰 사용량 (질문당)

| 구분 | 값 |
|---|---|
| 입력 토큰 | 약 900 |
| 출력 토큰 | 15 ~ 260 (답 길이에 따라) |

검색 품질

관련 질문과 무관한 질문의 유사도가 0.66~0.74 대 0.53~0.59로 명확히 갈렸다.
이 갭이 거절 게이트가 실제로 동작하는 근거다.

테스트

단위 테스트 61개 통과 (`npm test`). 외부 의존성 없이 도는 순수 로직에 집중했다.

| 대상 | 개수 | 검증 내용 |
|---|---|---|
| 청킹 | 3 | 짧은 글은 1조각, 긴 글은 겹치며 분할, 겹침 구간 일치 |
| Rate Limiter | 4 | 용량만큼 통과·초과분 429, IP별 격리, 시간 경과 시 토큰 충전 |
| Token Bucket | 8 | 버스트 허용·초과 거절, 대기 시간 안내, 충전 상한, 키별 격리, drop·sweep 회수 |
| Circuit Breaker | 9 | 임계치 도달 시 오픈, 성공 시 카운터 리셋, 쿨다운 후 복구, 반열림에서 시험 요청 한 건만 |
| Admission Control | 6 | 상한까지 통과, 큐 양보, 큐 포화 시 즉시 거절, 대기 데드라인 |
| 채팅 방 관리 | 17 | 퇴장 시 목록에서 제거(유령 사용자 방지), 빈 방 정리(메모리 누수 방지), 히스토리 50개 상한, 방 격리, 방 무한 증식 방지 |
| 소켓 페이로드 방어 | 6 | 페이로드가 null·숫자·빈 객체로 와도 핸들러가 안 터짐 |
| 업로드 형식 판별 | 8 | 앞머리 바이트로 png·jpg·gif·webp 판별, 확장자를 파일명이 아니라 내용으로 결정, SVG·HTML 위장 거절, 빈 파일·잘린 파일에서 안 터짐 |

방어 레이어가 이 프로젝트의 핵심 주장이라, 주장하는 동작을 테스트로 고정했다.
Token Bucket은 `take(key, now)`처럼 시각을 인자로 받게 만들어, sleep 없이 시간을
주입해 충전 동작을 결정적으로 검증한다.

"소켓 페이로드 방어" 줄은 나중에 붙었다. 핸들러가 인자를 바로 구조분해하고 있었는데
(`socket.on("message", ({ text }) => ...`), 타입은 `{ text: string }`을 약속하지만 그건
컴파일 타임 얘기고 실제로는 `null`도 온다. 그러면 구조분해에서 TypeError가 나고,
Socket.IO가 리스너를 try/catch 없이 부르는 탓에 프로세스가 통째로 죽는다 — 브라우저
콘솔에서 `socket.emit("message")` 한 줄이면 접속자 전원이 끊겼다. 타입이 지켜주는 범위와
지켜주지 않는 범위(신뢰 경계)를 이때 확실히 갈랐다.

---

## 핵심 로직 발췌

거절 게이트 — 이 프로젝트의 정체성 (server/routes/chat.ts)

```ts
const topSimilarity = rows[0]?.similarity ?? 0;

if (rows.length === 0 || topSimilarity < THRESHOLD) {
  send({ type: "refusal", message: "문서에서 관련 내용을 찾지 못했어요" });
  res.end();          // 여기서 끝 — AI를 부르지도 않는다
  return;
}
```

벡터 검색 — pgvector 코사인 거리 (server/routes/chat.ts)

```sql
select c.content, d.filename,
       1 - (c.embedding <=> $1::vector) as similarity   -- <=> 거리, 1- 로 유사도
  from chunks c
  join documents d on d.id = c.document_id
 order by c.embedding <=> $1::vector                     -- 가까운 순
 limit 5
```

겹치는 청킹 (server/chunk.ts)

```ts
const step = size - overlap;                 // 200 - 40 = 160
for (let start = 0; start < words.length; start += step) {
  chunks.push(words.slice(start, start + size).join(" "));
  if (start + size >= words.length) break;
}
```

소켓 이벤트 계약 — 오타를 컴파일에서 잡는 장치 (server/realtime/types.ts)

```ts
// 클라이언트 → 서버 (서버가 듣는 이벤트)
export interface ClientToServer {
  hello: (payload: { nickname: string }) => void; // 닉네임 등록 → 로비 진입
  join: (payload: { room: string }) => void;      // 방 입장 (없으면 생성) / 방 이동
  leave: () => void;                              // 방만 나가고 로비로
  message: (payload: { text: string }) => void;
  image: (payload: { imageId: string }) => void;  // 바이트가 아니라 id만 (아래 이미지 항목)
  typing: () => void;
}
// hello와 join을 나눈 이유: 닉네임은 로비에서 한 번 정하고, 방은 그 뒤로 몇 번이든
// 옮겨 다닌다. 한 이벤트에 묶으면 방을 옮길 때마다 닉네임을 다시 실어 보내게 되고,
// 그 값이 매번 달라도 서버가 알 길이 없다.
// (ServerToClient는 rooms / history / message / presence / system / typing / chatError)

// 이 계약을 제네릭으로 넘기면 emit/on의 이름과 payload가 타입 검사를 받는다
const io: Server<ClientToServer, ServerToClient, ..., SocketData> =
  new Server(httpServer, { ... });
```

전체 코드는 저장소 참고. 부하·장애 대응의 설계 근거와 측정값은
[RELIABILITY.md](RELIABILITY.md)에 따로 정리해두었다.

---

## 한계와 다음

- 대화 맥락(멀티턴)이 없다. 질문 단위로 동작한다.
- PDF는 파싱 품질 편차가 커서 txt·md에 집중했다.
- 검색이 임베딩 유사도 하나에 의존한다. 키워드 검색을 섞는 하이브리드 검색이
  다음 후보다.
- 거절 임계값을 로그를 보며 수동으로 맞추고 있다. 정답이 있는 질문 세트로
  자동 측정하는 것이 다음 목표다.
- 클라이언트가 응답 도중 떠나도 서버는 LLM 스트림을 끝까지 소비한다.
  연결 종료를 감지해 생성을 중단하는 것이 다음 개선 후보다.
- 실시간 채팅의 방 상태와 최근 기록이 서버 메모리에 있다. 서버가 죽으면 날아가고,
  서버를 여러 대로 늘리면 방이 갈라진다. 영구 저장과 Redis 어댑터가 다음 단계다.
  (문서 Q&A 쪽 인메모리 캐시가 서버 한 대를 전제하는 것과 같은 한계다.)

---

## 실행

```bash
# DB (pgvector 포함)
docker compose up -d

# 서버
cd server && cp .env.example .env   # GEMINI_API_KEY 입력
npm install && npm run dev

# 프론트
cd web && npm install && npm run dev   # http://localhost:5173
```

테스트와 대시보드 데모:

```bash
cd server && npm test                # 단위 테스트 61개
cd server && npm run typecheck       # tsc는 검사만 (빌드 산출물 없음)
cd server && npm run start:demo      # mock LLM 모드 — 대시보드에서 장애 주입 시연
```
