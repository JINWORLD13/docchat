**한국어** | [日本語](README.ja.md)

# DocChat

문서(txt, md)를 업로드하면 그 문서 내용을 근거로만 답변하는 RAG 챗봇임.
여기에 여러 명이 같은 방에서 대화하는 실시간 채팅을 함께 넣었음.
TypeScript, React, Express, PostgreSQL(pgvector), Socket.IO, Gemini API로 만들었음.

한 서버가 두 종류의 실시간을 다룸 — 답변 토큰은 SSE(한 방향), 채팅은
WebSocket(양방향 1:N). 왜 나누지 않고 한 프로세스에 뒀는지는
[PORTFOLIO.md](PORTFOLIO.md)에 정리했음.

> 함께 보기 — [PORTFOLIO.md](PORTFOLIO.md): 기술 선택과 그 이유 ·
> [RELIABILITY.md](RELIABILITY.md): 부하·장애 대응 설계와 측정값

![답변과 근거 출처](docs/demo-answer.png)

답변 위에 참고한 문서와 유사도가 뜨고, 본문의 [1], [2]가 그 출처와 연결됨.

![문서에 없으면 거절](docs/demo-refusal.png)

문서에 없는 내용이면 지어내지 않고 거절함. 이때 LLM은 호출조차 하지 않음.

![실시간 채팅](docs/demo-chat.png)

같은 방에 들어온 사람들끼리 메시지가 오감. 방 목록·접속자·입장 알림·입력 중 표시까지
소켓 하나로 처리함. 문서 Q&A(SSE)와 같은 서버, 같은 포트에서 돎.

![LLM 장애 주입 시 대시보드](docs/demo-dashboard-breaker.png)

대시보드에서 트래픽 폭주와 LLM 장애를 직접 주입하고, 방어 레이어(Rate Limiter,
Admission Control, Bulkhead, Circuit Breaker)가 반응하는 걸 실시간으로 볼 수
있음. 위 화면은 LLM이 완전히 죽은 상태 — 회로가 열렸고, 20건 중 하드 에러는 0이며
사용자는 출처를 계속 받음. 설계 근거는 [RELIABILITY.md](RELIABILITY.md).

## 왜 만들었나

LLM API를 한 번 호출해서 답을 받는 것과, 믿고 쓸 수 있는 AI 기능을 만드는 것은
다른 문제라고 생각했음. 이 프로젝트는 그 차이를 직접 구현해보기 위해 시작했음.
검색(RAG), 근거 표시, 모르면 모른다고 답하기, 스트리밍 응답, 토큰 로깅까지 —
실제 서비스라면 필요할 것들을 작은 범위에서 전부 넣어봤음.

## 동작 방식

```
[문서 업로드]
파일 → 어절 단위로 겹치게 청킹 → Gemini 임베딩(768차원) → pgvector 저장

[질문]
질문 임베딩 → 코사인 유사도 검색 top 5
  → 최고 유사도 < 임계값 : 답변 거절 (LLM 호출 안 함)
  → 통과 : 발췌를 프롬프트에 넣고 생성 → SSE 스트리밍
→ 근거(출처)와 토큰 사용량 표시, query_logs에 기록
```

## 신경 쓴 부분

### 모르면 모른다고 답하게

문서에 없는 질문에 그럴듯한 답을 지어내는 게 RAG의 가장 나쁜 실패라고 봤음.
검색된 최고 유사도가 임계값(기본 0.62)보다 낮으면 LLM을 아예 호출하지 않고
거절함. 헛소리도 막고 토큰도 아낌. 임계값은 그냥 찍은 게 아니라 샘플 문서로
관련 질문(유사도 0.66~0.74)과 무관 질문(0.53~0.59)을 재보고 그 사이로 잡았음.
문서가 바뀌면 질문마다 `query_logs`에 남는 유사도를 보고 다시 맞춤.

```sql
select question, refused, top_similarity from query_logs order by id desc limit 20;
```

### 답변마다 근거 보여주기

답변에 쓴 발췌의 파일명, 유사도, 미리보기를 답변 위에 붙이고 본문에도 [1], [2]로
번호를 달아 둠. 근거는 생성 시작 전에 먼저 내려보내서 스트리밍 중에도 출처가
보임.

### 벡터 검색은 pgvector로

별도 벡터 DB 없이 Postgres에 vector 컬럼을 두고 `<=>`(코사인 거리) 연산자와
HNSW 인덱스로 검색함. 문서 메타데이터랑 벡터를 한 DB에서 같이 관리할 수 있어서
골랐음.

### 겹치는 청킹

청크 경계에서 문장이 잘리면 검색에 안 걸릴 수 있어서 어절 200개 단위로 40개씩
겹치게 자름. 순수 함수라 테스트를 붙여놨음.

### 과부하와 장애를 견디는 설계

Rate Limiter(Token Bucket), Admission Control(동시 상한 + 대기 데드라인),
Bulkhead(읽기·쓰기·미디어 세 풀로 격리 — 이미지 조회가 질문 응답을 굶기지 않게),
Circuit Breaker, Graceful Degradation을 직접 구현했음. 병목은 추측하지 않고
부하를 걸어 측정했고(LLM이 아니라 DB 풀이었음), 각 레이어의 동작을 단위
테스트로 고정했음. (`cd server && npm test` — 61개)

설계 근거·대안 비교·측정값은 [RELIABILITY.md](RELIABILITY.md)에 정리했음.

### 실시간 채팅

닉네임을 정하면 로비로 들어가고, 왼쪽 방 목록에서 방을 고르거나 새로 만들어
입장함. 방 목록은 인원수와 함께 실시간으로 갱신되고, 방 안에서는 접속자 목록,
입력 중 표시, 입·퇴장 알림, 재입장 시 최근 50개 기록까지 동작함.

방 "생성"과 "입장"을 따로 두지 않았음 — 없는 이름으로 들어가면 그 자리에서
만들어지고, 마지막 사람이 나가면서 대화 기록도 없으면 목록에서 사라짐. 빈 방을
남겨두면 한 번 쓴 이름이 영원히 쌓이는데, 치워줄 사람이 없는 구조라 스스로
정리되는 쪽을 택했음.

문서 Q&A와 같은 서버·같은 포트(4000)를 씀. 나누지 않은 이유는 전송 방식이 다를
뿐 운영해야 할 프로세스를 늘릴 이유는 없기 때문임. 합치고 나니 오히려 중복이
드러났음 — HTTP 요청 제한과 채팅 도배 제한이 같은 Token Bucket을 각자 복사해
갖고 있었고, 이걸 `server/tokenbucket.ts` 하나로 뽑아 양쪽이 공유하게 했음(값만
용도별로 다르게 줌). 대시보드에도 채팅 방·접속자 수와 도배로 막힌 메시지 수가
함께 뜸.

### 이미지 전송

파일 선택, 붙여넣기(스크린샷), 드래그앤드롭 세 가지로 이미지를 보냄.
이미지는 Postgres에 `bytea`로 저장함.

**바이트를 소켓으로 보내지 않음.** 먼저 HTTP로 업로드하고, 소켓에는 id만 실어
보냄. 소켓에 실으면 사진 한 장이 방 인원수만큼 복제돼 나가고, 메모리에 든 최근
50개 기록에도 이미지가 통째로 쌓임.

**주소는 서버가 만듦.** 업로드는 URL이 아니라 id만 돌려줌. 클라이언트가 URL을
정할 수 있으면 `https://evil.example.com/tracker.gif` 같은 주소를 방 전체에
뿌려서, 그 방 사람들 브라우저가 남의 서버로 요청을 보내게 만들 수 있음. 서버는
받은 id가 자기가 발급한 것인지 확인한 뒤에야 주소를 붙임.

**형식은 앞머리 바이트로 판별함.** 파일명도 Content-Type도 클라이언트가 적어
보내는 값이라 믿지 않음. png/jpg/gif/webp의 고정 서명을 직접 확인하고, **SVG는
일부러 뺐음** — SVG는 XML이라 `<script>`가 들어가고, 같은 오리진에서 내려보내는
순간 저장형 XSS가 됨. 응답에는 `X-Content-Type-Options: nosniff`를 같이 보냄.

**조회는 별도 커넥션 풀로 격리했음.** 이미지 조회는 메시지가 뜰 때마다 나가는
잦고 무거운 읽기라, 질문 검색용 읽기 풀에 태우면 사진 많은 방 하나가 이 프로젝트가
"사수하겠다"고 말한 경로를 굶김. id가 uuid이고 내용이 안 바뀌므로 불변 캐시
헤더를 줘서, DB까지 오는 건 각 이미지의 첫 요청뿐임.

### 이벤트 계약을 타입으로 고정

HTTP는 경로를 틀리면 404가 바로 오지만, 소켓 이벤트는 이름이 문자열이라
`"typing"`을 `"typeing"`으로 써도 아무 일도 안 일어남 — 에러조차 안 남. 그래서
Socket.IO를 제네릭으로 감싸 `emit`/`on`의 이름과 payload를 컴파일 때 검사하게
했음. SSE 이벤트도 같은 이유로 유니온 타입으로 못박아, 서버가 이벤트를 추가하면
프런트에서 처리를 빠뜨렸을 때 타입 검사에 걸림.

서버는 빌드 단계 없이 Node가 타입만 벗겨 실행함(`node index.ts`). `tsc`는
검사기로만 씀(`npm run typecheck`).

### 스트리밍과 일시 오류 대응

답변은 SSE로 스트리밍하고, 질문마다 유사도, 토큰 사용량, 응답 시간을 DB에 남김.
무료 티어 rate limit을 생각해서 임베딩 요청은 나눠 보내고, API가 일시적
오류(429, 5xx)를 주면 지수 백오프로 재시도함. 실제로 개발 중에 임베딩 API가
503을 뱉어서 답변이 실패하는 걸 겪고 넣었음. 반대로 400, 404처럼 재시도해도
소용없는 오류는 바로 사용자에게 알림.

## 기술 스택

- 언어: TypeScript (서버·프런트 모두)
- 프론트: React (Vite)
- 백엔드: Node.js + Express + Socket.IO
- DB: PostgreSQL + pgvector
- AI: Gemini API — `gemini-embedding-001`(임베딩) + `gemini-3.6-flash`(생성), 무료 티어로 동작

## 실행 방법

1. DB 실행 (pgvector 포함, 최초 실행 시 schema.sql 자동 적용)

```bash
docker compose up -d
```

2. 서버

```bash
cd server
cp .env.example .env   # GEMINI_API_KEY 입력 (https://aistudio.google.com/apikey 무료 발급)
npm install
npm run dev
```

서버가 떴는지는 `curl http://localhost:4000/api/health` → `{"ok":true}`로 확인함.

3. 프론트

```bash
cd web
cp .env.example .env   # 선택 — 로컬 데모는 비워둔 채로 그대로 동작합니다
npm install
npm run dev   # http://localhost:5173
```

프런트 환경 변수는 `web/.env.example`에 있음. Vite는 `web/` 아래의 `.env*`만
읽으므로, 서버 쪽 `.env`에 `VITE_`로 시작하는 값을 넣어도 빌드에 반영되지 않음.
지금 쓰는 값은 대시보드의 장애 주입 버튼용 `VITE_ADMIN_TOKEN` 하나뿐이고, 로컬은
루프백이라 비워두면 됨. 이 값을 채워 배포하면 번들에 평문으로 들어가 방문자
누구나 읽을 수 있다는 점만 유의할 것(파일의 주의 사항 참고).

`sample-docs/`의 문서 두 개를 올리고 이렇게 물어보면 됨.

- "환불은 며칠 걸려?" → 문서 근거로 답변 + 출처 표시
- "반품 배송비는 누가 부담해?" → 조건별로 나눠서 답변
- "프랑스의 수도는?" → 거절 (문서에 없는 내용)

실시간 채팅은 상단 "실시간 채팅" 탭에서 확인함. 브라우저 탭을 두 개 열고 같은
방 이름으로 들어가면 서로 대화가 오감. 텍스트 대화는 DB 없이도 되고, 이미지
전송은 `chat_images` 테이블이 있어야 함(schema.sql에 포함).

DB 스키마가 적용되지 않은 경우(볼륨을 먼저 만든 경우):

```bash
docker exec -i docchat-db psql -U postgres -d docchat < server/schema.sql
```

## 프로젝트 구조

```
server/
  index.ts            Express 앱 + Socket.IO 부착, /api/health, /api/metrics,
                      에러 미들웨어
  types.ts            SSE 이벤트 유니온, /api/metrics 응답 타입 (한 곳에서 관리)
  db.ts               pg 커넥션 풀 — 읽기·쓰기·미디어 세 개로 분리 (Bulkhead)
  gemini.ts           임베딩 / 스트리밍 생성 / 지수 백오프 재시도
  chunk.ts            겹침 청킹
  cache.ts            질문 임베딩 캐시 (TTL)
  imagetype.ts        업로드 바이트의 앞머리로 형식 판별 (SVG 제외)
  images.ts           채팅 이미지 저장/조회 (DB를 아는 코드를 여기 가둠)
  tokenbucket.ts      Token Bucket 알고리즘 — HTTP·소켓 제한이 공유
  ratelimit.ts        사용자(IP)별 HTTP 요청 제한
  admission.ts        동시 처리 상한 + 대기 데드라인 (load shedding)
  breaker.ts          LLM 회로 차단기
  admin.ts            장애 주입 엔드포인트 보호 (토큰 / 루프백)
  faults.ts           런타임 장애 주입 스위치 (데모용)
  routes/
    documents.ts      업로드, 목록, 원문 열람(GET), 수정(PUT), 삭제
    chat.ts           검색 → 거절 게이트 → 회로 확인 → SSE 스트리밍 → 로깅
    images.ts         채팅 이미지 업로드(POST) / 조회(GET, 불변 캐시)
  realtime/
    types.ts          소켓 이벤트 계약 (web와 짝)
    gateway.ts        연결·입장·브로드캐스트·퇴장 핸들러
    rooms.ts          방 상태 (메시지 50개 + 접속자) 메모리
    ratelimit.ts      소켓별 도배 제한
  scripts/            부하 테스트, 캐시 벤치, 방어 레이어 시연
  schema.sql
  tsconfig.json       빌드 없음 — Node가 타입을 벗겨 실행, tsc는 검사만
  *.test.ts           단위 테스트 61개
                      (청킹·token bucket·rate limit·breaker·admission·rooms
                       ·imagetype)
web/
  src/
    types.ts          서버와 맞춘 계약 (문서·SSE 이벤트·metrics)
    api.ts            fetch + SSE 파싱 (이벤트별 핸들러 디스패치)
    App.tsx           상단 탭 — 문서 Q&A / 실시간 채팅 / 대시보드
    components/       Sidebar(업로드/목록) / Chat / Message(근거 표시)
                      DocModal(열람·수정 팝업) / Dashboard(부하·장애 대시보드)
    realtime/
      types.ts        소켓 이벤트 계약 (server와 짝)
      socket.ts       타입 있는 소켓 (같은 오리진에 연결)
      LiveChat.tsx    소켓 연결 관리 + 닉네임 → 로비 → 방 전환
      Nickname.tsx    닉네임 입력
      RoomList.tsx    방 목록 + 새 방 만들기
      Room.tsx        구독·전송·접속자 목록
  vite.config.ts      /api 프록시 + /socket.io 프록시(ws)
sample-docs/          데모용 가상 쇼핑몰 문서
docs/                 README·포트폴리오용 스크린샷
docker-compose.yml    pgvector 포함 Postgres
```

문서 목록에서 항목을 누르면 팝업이 뜨고, 원문을 그 자리에서 고쳐 저장할 수 있음.
저장하면 그 문서만 다시 청킹·임베딩해서 검색에 반영함. 원문은 청크로 복원할 수
없어서(겹쳐 자르니까) `documents.content`에 따로 보관함.

## 한계와 다음에 해볼 것

- 대화 맥락(멀티턴)이 없음. 질문 단위로 동작함.
- PDF는 파싱 품질 문제가 커서 txt/md에 집중했음.
- 검색이 임베딩 유사도 하나에 의존함. BM25 키워드 검색을 섞는 하이브리드
  검색을 다음에 시도해보고 싶음.
- 거절 임계값을 로그를 보며 수동으로 조정하고 있는데, 평가용 질문 세트를
  만들어서 자동으로 측정하는 게 다음 목표임.
- 클라이언트가 응답 도중 떠나도 서버는 LLM 스트림을 끝까지 소비함.
  연결 종료(close) 이벤트를 감지해 생성을 중단하는 것이 다음 개선 후보임.
- 채팅 기록이 서버 메모리에만 있어서 서버가 재시작하면 사라짐. 단계별로는
  ① 지금: 단일 서버 인메모리(방·메시지·presence·도배 방지) → ② 메시지를
  Postgres에 남겨 durability 확보 → ③ Socket.IO Redis 어댑터로 pub/sub을 붙이고
  presence를 Redis로 옮겨, 다른 서버에 붙은 사용자에게도 메시지가 가게 하는
  순서를 생각하고 있음. 임베딩 캐시가 인메모리인 것과 같은 성격의 한계임.
- 채팅에 로그인이 없어 닉네임을 아무나 쓸 수 있음.
- 서버와 프런트가 이벤트 계약 타입을 각자 복사해 갖고 있음. 지금 규모에선
  워크스페이스를 도입하는 비용이 더 커서 미뤘고, 커지면 공용 패키지로 뺄 계획임.
- 배포는 Neon(pgvector 지원) + Render + Netlify 무료 티어 조합으로 올릴
  예정임.
