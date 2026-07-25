**한국어** | [日本語](README.ja.md)

# DocChat

문서(txt, md)를 업로드하면 그 문서 내용을 근거로만 답변하는 RAG 챗봇입니다.
React, Express, PostgreSQL(pgvector), Gemini API로 만들었습니다.

> 함께 보기 — [PORTFOLIO.md](PORTFOLIO.md): 기술 선택과 그 이유 ·
> [RELIABILITY.md](RELIABILITY.md): 부하·장애 대응 설계와 측정값 ·
> [STUDY.md](STUDY.md): 흐름별 상세 설명

![답변과 근거 출처](docs/demo-answer.png)

답변 위에 참고한 문서와 유사도가 뜨고, 본문의 [1], [2]가 그 출처와 연결됩니다.

![문서에 없으면 거절](docs/demo-refusal.png)

문서에 없는 내용이면 지어내지 않고 거절합니다. 이때 LLM은 호출조차 하지 않습니다.

![LLM 장애 주입 시 대시보드](docs/demo-dashboard-breaker.png)

대시보드에서 트래픽 폭주와 LLM 장애를 직접 주입하고, 방어 레이어(Rate Limiter,
Admission Control, Bulkhead, Circuit Breaker)가 반응하는 걸 실시간으로 볼 수
있습니다. 위 화면은 LLM이 완전히 죽은 상태 — 회로가 열렸고, 20건 중 하드 에러는
0이며 사용자는 출처를 계속 받습니다. 설계 근거는 [RELIABILITY.md](RELIABILITY.md).

## 왜 만들었나

LLM API를 한 번 호출해서 답을 받는 것과, 믿고 쓸 수 있는 AI 기능을 만드는 것은
다른 문제라고 생각했습니다. 이 프로젝트는 그 차이를 직접 구현해보기 위해
시작했습니다. 검색(RAG), 근거 표시, 모르면 모른다고 답하기, 스트리밍 응답,
토큰 로깅까지 — 실제 서비스라면 필요할 것들을 작은 범위에서 전부 넣어봤습니다.

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

문서에 없는 질문에 그럴듯한 답을 지어내는 게 RAG의 가장 나쁜 실패라고 봤습니다.
검색된 최고 유사도가 임계값(기본 0.62)보다 낮으면 LLM을 아예 호출하지 않고
거절합니다. 헛소리도 막고 토큰도 아낍니다. 임계값은 그냥 찍은 게 아니라 샘플
문서로 관련 질문(유사도 0.66~0.74)과 무관 질문(0.52~0.59)을 재보고 그 사이로
잡았습니다. 문서가 바뀌면 질문마다 `query_logs`에 남는 유사도를 보고 다시
맞춥니다.

```sql
select question, refused, top_similarity from query_logs order by id desc limit 20;
```

### 답변마다 근거 보여주기

답변에 쓴 발췌의 파일명, 유사도, 미리보기를 답변 위에 붙이고 본문에도 [1], [2]로
번호를 답니다. 근거는 생성 시작 전에 먼저 내려보내서 스트리밍 중에도 출처가
보입니다.

### 벡터 검색은 pgvector로

별도 벡터 DB 없이 Postgres에 vector 컬럼을 두고 `<=>`(코사인 거리) 연산자와
HNSW 인덱스로 검색합니다. 문서 메타데이터랑 벡터를 한 DB에서 같이 관리할 수
있어서 골랐습니다.

### 겹치는 청킹

청크 경계에서 문장이 잘리면 검색에 안 걸릴 수 있어서 어절 200개 단위로 40개씩
겹치게 자릅니다. 순수 함수라 테스트를 붙여놨습니다.

### 과부하와 장애를 견디는 설계

Rate Limiter(Token Bucket), Admission Control(동시 상한 + 대기 데드라인),
Bulkhead(읽기/쓰기 풀 격리), Circuit Breaker, Graceful Degradation을 직접
구현했습니다. 병목은 추측하지 않고 부하를 걸어 측정했고(LLM이 아니라 DB 풀이었습니다),
각 레이어의 동작을 단위 테스트로 고정했습니다. (`cd server && npm test` — 19개)

설계 근거·대안 비교·측정값은 [RELIABILITY.md](RELIABILITY.md)에 정리했습니다.

### 스트리밍과 일시 오류 대응

답변은 SSE로 스트리밍하고, 질문마다 유사도, 토큰 사용량, 응답 시간을 DB에
남깁니다. 무료 티어 rate limit을 생각해서 임베딩 요청은 나눠 보내고, API가
일시적 오류(429, 5xx)를 주면 지수 백오프로 재시도합니다. 실제로 개발 중에
임베딩 API가 503을 뱉어서 답변이 실패하는 걸 겪고 넣었습니다. 반대로 400,
404처럼 재시도해도 소용없는 오류는 바로 사용자에게 알립니다.

## 기술 스택

- 프론트: React (Vite)
- 백엔드: Node.js + Express
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

3. 프론트

```bash
cd web
npm install
npm run dev   # http://localhost:5173
```

`sample-docs/`의 문서 두 개를 올리고 이렇게 물어보면 됩니다.

- "환불은 며칠 걸려?" → 문서 근거로 답변 + 출처 표시
- "반품 배송비는 누가 부담해?" → 조건별로 나눠서 답변
- "프랑스의 수도는?" → 거절 (문서에 없는 내용)

DB 스키마가 적용되지 않은 경우(볼륨을 먼저 만든 경우):

```bash
docker exec -i docchat-db psql -U postgres -d docchat < server/schema.sql
```

## 프로젝트 구조

```
server/
  index.js            Express 앱, /api/metrics, 에러 미들웨어
  db.js               pg 커넥션 풀 — 읽기/쓰기 분리 (Bulkhead)
  gemini.js           임베딩 / 스트리밍 생성 / 지수 백오프 재시도
  chunk.js            겹침 청킹
  cache.js            질문 임베딩 캐시 (TTL)
  ratelimit.js        사용자별 Token Bucket 요청 제한
  admission.js        동시 처리 상한 + 대기 데드라인 (load shedding)
  breaker.js          LLM 회로 차단기
  admin.js            장애 주입 엔드포인트 보호 (토큰 / 루프백)
  faults.js           런타임 장애 주입 스위치 (데모용)
  routes/
    documents.js      업로드, 목록, 원문 열람(GET), 수정(PUT), 삭제
    chat.js           검색 → 거절 게이트 → 회로 확인 → SSE 스트리밍 → 로깅
  scripts/            부하 테스트, 캐시 벤치, 방어 레이어 시연
  schema.sql
  *.test.js           단위 테스트 19개 (청킹·rate limit·breaker·admission)
web/
  src/
    api.js            fetch + SSE 파싱
    App.jsx
    components/       Sidebar(업로드/목록) / Chat / Message(근거 표시)
                      DocModal(열람·수정 팝업) / Dashboard(부하·장애 대시보드)
sample-docs/          데모용 가상 쇼핑몰 문서
docs/                 README·포트폴리오용 스크린샷
docker-compose.yml    pgvector 포함 Postgres
```

문서 목록에서 항목을 누르면 팝업이 뜨고, 원문을 그 자리에서 고쳐 저장할 수
있습니다. 저장하면 그 문서만 다시 청킹·임베딩해서 검색에 반영합니다. 원문은
청크로 복원할 수 없어서(겹쳐 자르니까) `documents.content`에 따로 보관합니다.

## 한계와 다음에 해볼 것

- 대화 맥락(멀티턴)이 없습니다. 질문 단위로 동작합니다.
- PDF는 파싱 품질 문제가 커서 txt/md에 집중했습니다.
- 검색이 임베딩 유사도 하나에 의존합니다. BM25 키워드 검색을 섞는 하이브리드
  검색을 다음에 시도해보고 싶습니다.
- 거절 임계값을 로그를 보며 수동으로 조정하고 있는데, 평가용 질문 세트를
  만들어서 자동으로 측정하는 게 다음 목표입니다.
- 클라이언트가 응답 도중 떠나도 서버는 LLM 스트림을 끝까지 소비합니다.
  연결 종료(close) 이벤트를 감지해 생성을 중단하는 것이 다음 개선 후보입니다.
- 배포는 Neon(pgvector 지원) + Render + Netlify 무료 티어 조합으로 올릴
  예정입니다.
