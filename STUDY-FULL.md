# DocChat 전체 공부 노트

기존 [STUDY.md](STUDY.md)는 RAG 코어(문서 넣기 4칸 + 묻기 7칸)만 다룬다.
이 노트는 거기에 방어 레이어와 화면까지 붙여 프로젝트 전체를 백지에서 다시 칠 수 있게 만든 것이다.

순서: 기획 → 지도 → 만드는 순서 → 흐름 A/B/C/D 코드 → 원리 → 헷갈리는 것 → 검색할 것 → 자가 점검.

> 파일 경로는 TypeScript 전환에 맞춰 갱신했지만, 아래 코드 조각은 아직 전환 전의
> JavaScript 형태다(타입 표기 없음). 흐름과 판단을 익히는 데는 그대로 쓸 수 있고,
> 실제 타입이 붙은 코드는 소스 파일을 보면 된다.
> 실시간 채팅 부분은 [STUDY-REALTIME.md](STUDY-REALTIME.md)에 따로 있다.

---

# 0. 기획 — 코드 치기 전에 정하는 것

무슨 문제를 푸나
  AI가 우리 문서를 몰라서 아무 말이나 지어내는 문제. 그리고 그렇게 만든 AI 기능이
  트래픽이 몰리거나 외부 API가 죽으면 통째로 멈추는 문제. 두 개다.

사용 시나리오
  1) 문서 올린다 2) 질문한다 3) 근거 문서와 함께 답이 뜬다 4) 없는 질문이면 없다고 한다
  5) 몰려도 안 죽는다 6) LLM이 죽어도 출처는 준다.
  1~4에서 API가 나오고, 5~6에서 방어 레이어가 나온다.

안 할 것 (스코프)
  멀티턴 대화, PDF, 로그인, 문서 공유, 분산 rate limit, 재랭킹.
  핵심(RAG 정확도 + 장애 대응)에 집중하려고 뺀다.

데이터 흐름 두 줄 (나침반)
  넣기: 문서 → 조각내기 → 숫자로 → 저장
  묻기: 질문 → 숫자로 → 비슷한 조각 찾기 → 그걸 근거로 답 생성

방어 흐름 한 줄
  요청 → 사용자별 제한 → 동시 처리 상한 → 풀 격리 → 회로차단 → (실패해도) 대체 응답

뭘 저장할지 (화면에서 거꾸로)
  목록 보여주려면 파일명(documents), 검색하려면 조각+벡터(chunks),
  임계값 조정하려면 질문 기록(query_logs). 표 3개.

기술 선택 (제약에서 출발)
  제약: 무료여야 함, 혼자 만듦, 짧게 끝냄.
  Gemini 무료 티어(카드 불필요) · pgvector(Postgres 하나로) · React(익숙) · SSE(단방향이라 충분).
  방어 레이어는 라이브러리 대신 직접 구현 — 동작을 설명할 수 있어야 포트폴리오가 되니까.

완료 기준
  올리면 조각 수가 뜬다 / "환불 며칠?" 근거와 함께 답한다 / "프랑스 수도?" 거절한다 /
  답이 흐른다 / 동시 20발 쏴도 5xx가 0이다 / LLM을 죽여도 출처가 나온다.

---

# 1. 전체 지도 (21칸)

| 칸 | 하는 일 | 파일 |
|---|---|---|
| A1 | 파일 받아 글자 꺼내기 | server/routes/documents.ts |
| A2 | 겹치게 조각내기 | server/chunk.ts |
| A3 | 조각을 숫자(벡터)로 | server/gemini.ts |
| A4 | DB에 트랜잭션으로 저장 | server/routes/documents.ts |
| B1 | 질문 받고 스트리밍 준비 | server/routes/chat.ts |
| B2 | 질문을 숫자로 (캐시 경유) | server/gemini.ts |
| B3 | 가까운 조각 5개 찾기 | server/routes/chat.ts |
| B4 | 멀면 거절 (LLM 안 부름) | server/routes/chat.ts |
| B5 | 프롬프트 조립 | server/gemini.ts |
| B6 | 답을 조각조각 전송 | server/routes/chat.ts |
| B7 | 화면에서 받아 붙이기 | web/src/api.ts |
| C1 | 사용자별 요청 제한 | server/ratelimit.ts |
| C2 | 동시 처리 상한 + 대기 데드라인 | server/admission.ts |
| C3 | 읽기/쓰기 풀 격리 | server/db.ts |
| C4 | LLM 회로 차단 | server/breaker.ts |
| C5 | 실패해도 출처는 준다 | server/routes/chat.ts |
| C6 | 질문 임베딩 캐시 | server/cache.ts |
| D1 | 사이드바 — 업로드·목록·삭제 | web/src/components/Sidebar.tsx |
| D2 | 채팅 — 스트리밍 상태 관리 | web/src/components/Chat.tsx |
| D3 | 말풍선 — 출처·토큰 표시 | web/src/components/Message.tsx |
| D4 | 대시보드 — 장애 주입과 관찰 | web/src/components/Dashboard.tsx |

A는 넣기 4칸, B는 묻기 7칸, C는 방어 6칸, D는 화면 4칸.
이 넷을 이어붙이는 게 server/index.ts(서버 뼈대)와 web/src/App.tsx(화면 뼈대).

C는 B 위에 얹히는 층이다. A/B가 없으면 C는 지킬 게 없다. 순서상 A→B→C.

---

# 2. 만드는 순서

원칙: 처음부터 서버를 만들지 않는다. 의존성 없는 순수 함수부터 시작해
외부 연결 → 저장 → 검색 → 생성 순으로 쌓고, 마지막에 서버로 옮긴다.
한 칸 만들 때마다 반드시 켜보고 다음으로 간다.

| 순서 | 만드는 것 | 왜 이때 | 켜보기(성공 신호) |
|---|---|---|---|
| 1 | chunk.ts | 의존성 0, 순수함수 | 450어절 → 조각 3개? |
| 2 | gemini.ts (임베딩만) | 첫 외부 연결 확인 | 벡터 길이 768? |
| 3 | schema.sql + db.ts | 담을 그릇 | `select 1+1` 동작? |
| 4 | 저장 스크립트 | 1~3을 처음 합침 | 저장 완료 로그? |
| 5 | 검색 스크립트 | 줄기의 심장 | 관련 조각이 1등? |
| 6 | 생성 (한 방에, 스트리밍 없이) | 줄기 완성 | 터미널에 답 출력? |
| 7 | index.ts + 라우트로 옮기기 | 스크립트를 서버로 | curl로 답 받기? |
| 8 | 거절 게이트 | 헛소리부터 막는다 | "프랑스 수도?" 거절? |
| 9 | SSE 스트리밍 | 6이 검증됐으니 얹는다 | 글자가 흐르나? |
| 10 | 화면 (Sidebar/Chat/Message) | 백엔드가 끝난 뒤 | 브라우저에서 대화? |
| 11 | query_logs + 재시도 | 운영에 필요한 관측 | 로그 행이 쌓이나? |
| 12 | 부하 측정 (mock 서버) | 병목을 추측하지 않으려고 | RPS/p99 숫자가 나오나? |
| 13 | 캐시 → 로그 분리 → 풀 튜닝 | 12에서 나온 병목 순서대로 | p99가 줄었나? |
| 14 | ratelimit → admission → breaker | 예방 → 격리 → 차단 순 | 단위 테스트 초록? |
| 15 | 대시보드 + 장애 주입 | 방어가 있어야 보여줄 게 있음 | 버튼 누르면 회로가 열리나? |

6번까지가 줄기다. 여기까지면 화면이 없어도 RAG는 완성이다.
12번이 분기점 — 여기서 병목이 LLM이 아니라 DB 풀로 나왔고, 13~14의 순서가 그 측정에서 정해졌다.

어려운 것(스트리밍)은 9번에 있다. 6번에서 한 방에 받는 버전으로 로직을 먼저 검증했기 때문에,
9번에서 문제가 나면 "스트리밍 코드가 문제"라고 범위를 좁힐 수 있다.

---

# 3. 흐름 A — 문서 넣기

## A0. 서버 뼈대

상황: 라우터를 붙일 자리를 만드는 중
파일: server/index.ts

```js
const app = express();

// 프록시(배포 시 로드밸런서) 뒤에서 req.ip가 실제 클라이언트 IP를 가리키게 한다.
// true(모든 홉 신뢰)가 아니라 1인 이유: 전부 신뢰하면 클라이언트가
// X-Forwarded-For 헤더를 직접 넣어 req.ip를 조작할 수 있고, IP별로 버킷을
// 나누는 rate limiter가 "요청마다 새 IP"로 통째로 우회된다.
app.set("trust proxy", 1);
app.use(cors());          // 프론트(5173)와 서버(4000)가 다른 포트라 필요
app.use(express.json());  // JSON 본문을 req.body로 파싱

app.use("/api/documents", documentsRouter);
// rateLimit을 chat 앞단에 둔다: 맨 먼저 사용자별 폭주를 걸러낸 뒤 라우터로 넘긴다.
app.use("/api/chat", rateLimit, chatRouter);
```

여기서 중요한 건 순서다. `rateLimit`이 `chatRouter`보다 앞에 있어야 폭주가 라우터에 도달하기 전에 잘린다.
업로드(documents)에는 rate limit이 없다 — 폭주 경로가 아니고, 대신 파일 크기 상한으로 막는다.

## A1. 파일 받아 글자 꺼내기

상황: 사용자가 파일을 골랐고 서버가 받는 자리
파일: server/routes/documents.ts

```js
const upload = multer({
  storage: multer.memoryStorage(),   // 디스크에 안 쓰고 메모리로 받는다 (바로 임베딩할 거라)
  limits: { fileSize: 1024 * 1024 }, // 1MB 상한. 넘으면 multer가 에러를 던짐
});

// upload.single("file") = 파일 1개를 받아 req.file에 담아주는 미들웨어
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "파일이 없습니다." });  // 400 = 잘못된 요청
  }

  // multer는 파일명을 latin1로 해석해서 한글 파일명이 깨진다. utf8로 되돌려준다.
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");

  if (!/\.(txt|md)$/i.test(filename)) {   // i = 대소문자 무시 (.TXT도 통과)
    return res.status(400).json({ error: "txt, md 파일만 업로드할 수 있습니다." });
  }

  const text = req.file.buffer.toString("utf8");  // 이진 데이터 → 사람이 읽는 글자
  if (!text.trim()) {
    return res.status(400).json({ error: "문서 내용이 비어 있습니다." });
  }
```

데이터 모양: `<Buffer 23 20 ed 99 98...>` → `"# 환불 정책\n\n환불은 7일 이내..."` (문자열)

1MB 상한을 넘기면 여기까지 오지 않고 index.ts의 에러 핸들러로 간다.

상황: multer가 크기 상한 초과를 던졌을 때 받는 자리
파일: server/index.ts

```js
app.use((err, req, res, next) => {          // 인자 4개짜리 = Express 에러 핸들러
  if (err.code === "LIMIT_FILE_SIZE") {     // multer가 붙여주는 코드
    return res.status(400).json({ error: "파일은 1MB 이하만 업로드할 수 있습니다." });
  }
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});
```

## A2. 겹치게 조각내기

상황: 통글을 검색 단위로 쪼개는 중. 의존성 0인 순수 함수라 제일 먼저 만든 칸
파일: server/chunk.ts

```js
// 문서를 공백 단위(어절)로 자른 뒤 겹치는 창으로 묶는다.
// 겹침 없이 자르면 "환불은 영업일 기준 3~5일" 같은 문장이
// 청크 경계에서 반으로 잘려 검색에 안 걸릴 수 있어서 overlap을 둔다.
export function chunkText(text, size = 200, overlap = 40) {
  const words = text.split(/\s+/).filter(Boolean);  // 공백(여러 개 포함)으로 쪼개고 빈 값 제거
  if (words.length === 0) return [];                // 빈 글은 빈 배열 (호출 쪽에서 분기 안 하게)

  const chunks = [];
  const step = size - overlap;                      // 160 — 다음 조각의 시작점 간격
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + size).join(" "));  // 200개 떼서 다시 글로
    if (start + size >= words.length) break;        // 이번 조각이 끝까지 먹었으면 종료
  }
  return chunks;
}
```

데이터 모양: `"통글"` → `["단어","단어",...450개]` → `["조각1 글", "조각2 글", "조각3 글"]`

`break`가 없으면 마지막에 몇 어절짜리 꼬리 조각이 하나 더 생긴다.
`start + size >= words.length`는 "이번 창이 끝을 덮었다"는 뜻이라 거기서 멈춘다.

상황: 이 함수만 따로 검증하는 중 (순수 함수라 DB도 API도 없이 테스트 가능)
파일: server/chunk.test.ts

```js
test("긴 글은 겹치면서 나뉜다", () => {
  const words = Array.from({ length: 450 }, (_, i) => `단어${i}`);
  const chunks = chunkText(words.join(" "), 200, 40);

  assert.equal(chunks.length, 3);
  // 앞 청크의 마지막 40어절 == 다음 청크의 처음 40어절
  const first = chunks[0].split(" ");
  const second = chunks[1].split(" ");
  assert.deepEqual(first.slice(-40), second.slice(0, 40));
});
```

겹침이 실제로 40개인지를 "앞 조각 꼬리 == 뒤 조각 머리"로 확인한다.
개수(3개)만 맞춰서는 겹쳤는지 알 수 없다.

## A3. 조각을 숫자(벡터)로

상황: 조각들을 검색 가능한 형태로 바꾸는 중
파일: server/gemini.ts

```js
const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIM = 768;   // pgvector 컬럼 차원과 맞춰야 한다 (schema.sql의 vector(768))

// 문서 저장용과 질문용은 taskType이 다르다.
// 같은 텍스트라도 용도에 맞는 taskType을 줘야 검색 품질이 좋아진다.
export async function embedTexts(texts, taskType = "RETRIEVAL_DOCUMENT") {
  if (PROVIDER === "mock") return texts.map((t) => mockVector(t));  // 부하 테스트용 우회

  const result = await withRetry(
    () =>
      ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts,                                 // 배열로 여러 개를 한 번에
        config: { taskType, outputDimensionality: EMBEDDING_DIM },
      }),
    "임베딩"
  );
  return result.embeddings.map((e) => e.values);  // [{values:[...]}, ...] → [[...], ...]
}
```

데이터 모양: `["조각1","조각2"]` → `{embeddings:[{values:[...768]},{values:[...768]}]}` → `[[...768],[...768]]`

`map`으로 껍데기(`{values:}`)를 벗기는 이유는 DB에 넣을 때 숫자 배열만 필요하기 때문이다.

상황: 무료 티어가 429/503을 뱉었을 때 살아남는 자리
파일: server/gemini.ts

```js
// 일시적 오류(429 rate limit, 5xx 서버 장애)는 잠깐 기다렸다 다시 부르면
// 대부분 성공한다. 반대로 400/404 같은 건 재시도해도 소용없으니 바로 던진다.
const RETRYABLE = new Set([429, 500, 503, 504]);

async function withRetry(fn, label) {
  const delays = [500, 1000, 2000];               // 지수 백오프 — 점점 더 오래 기다린다
  for (let attempt = 0; ; attempt++) {            // 종료 조건은 안에서 처리
    try {
      return await fn();
    } catch (e) {
      if (!RETRYABLE.has(e?.status) || attempt >= delays.length) throw e;  // 못 고칠 오류거나 소진
      await new Promise((r) => setTimeout(r, delays[attempt]));            // 기다렸다 재시도
    }
  }
}
```

간격을 500 → 1000 → 2000으로 늘리는 이유: 서버가 이미 과부하인데 같은 간격으로 계속 두들기면
그 서버를 더 밀어붙이는 셈이 된다. 물러서면서 재시도해야 회복할 틈을 준다.

상황: 임베딩을 한 번에 다 보내지 않고 나눠 보내는 자리
파일: server/routes/documents.ts

```js
const MAX_CHUNKS = 300;
const EMBED_BATCH = 10;

// 크기 상한 검사는 임베딩 전에 한다 — 초과 문서를 전부 임베딩하고 나서
// 버리면 API 호출(무료 티어 rate limit 포함)만 낭비하기 때문.
async function chunkAndEmbed(text) {
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) return { tooLarge: true, chunks, embeddings: [] };

  const embeddings = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {          // 10개씩 끊어서
    embeddings.push(...(await embedTexts(chunks.slice(i, i + EMBED_BATCH))));
  }
  return { chunks, embeddings };
}
```

`push(...배열)`은 배열을 통째로 넣는 게 아니라 항목들을 펼쳐 넣는다.
`push(배열)`로 쓰면 `[[...],[...]]` 같은 중첩이 되어 인덱스가 어긋난다.

## A4. DB에 트랜잭션으로 저장

상황: 문서 1행과 조각 N행을 한 덩어리로 저장하는 중
파일: server/routes/documents.ts

```js
const client = await pool.connect();      // 풀에서 커넥션 하나를 "빌린다"
try {
  await client.query("begin");            // 여기부터 한 덩어리
  const docResult = await client.query(
    "insert into documents (filename, content) values ($1, $2) returning id",
    [filename, text]                      // $1,$2 = 값 자리표시자. SQL 인젝션 방지
  );
  const docId = docResult.rows[0].id;     // returning id 로 방금 만든 행의 id를 받는다
  await insertChunks(client, docId, chunks, embeddings);
  await client.query("commit");           // 전부 성공했을 때만 확정
  res.json({ id: docId, filename, chunkCount: chunks.length });
} catch (e) {
  await client.query("rollback");         // 하나라도 실패하면 전부 없던 일로
  throw e;
} finally {
  client.release();                       // 성공이든 실패든 커넥션은 반드시 반납
}
```

트랜잭션이 없으면 "문서는 저장됐는데 조각은 0개"인 반쪽 문서가 남는다.
그 문서는 목록에는 뜨는데 검색에는 절대 안 걸린다 — 사용자가 원인을 알 수 없는 상태다.

`client.connect()`로 같은 커넥션을 계속 쓰는 이유: `begin`/`commit`은 커넥션 단위라
`pool.query()`로 나눠 쏘면 서로 다른 커넥션에 걸려 트랜잭션이 성립하지 않는다.

상황: 조각을 한 행씩 넣는 중
파일: server/routes/documents.ts

```js
async function insertChunks(client, docId, chunks, embeddings) {
  for (let i = 0; i < chunks.length; i++) {
    await client.query(
      `insert into chunks (document_id, chunk_index, content, embedding)
       values ($1, $2, $3, $4)`,
      [docId, i, chunks[i], JSON.stringify(embeddings[i])]   // 벡터는 문자열로 넘긴다
    );
  }
}
```

데이터 모양: `[0.1, -0.2, ...]` (JS 배열) → `"[0.1,-0.2,...]"` (문자열) → `vector(768)` (pgvector 타입)

pgvector는 `"[0.1,0.2,...]"` 형태의 문자열을 받아 vector로 해석한다.
JS 배열을 그대로 넘기면 pg 드라이버가 Postgres 배열(`{0.1,0.2}`)로 보내서 타입이 안 맞는다.

## A4-b. 저장 그릇

상황: 표 3개를 정의하는 중
파일: server/schema.sql

```sql
create extension if not exists vector;   -- pgvector 켜기 (docker 이미지에 포함돼 있음)

create table if not exists documents (
  id serial primary key,
  filename text not null,
  -- 원문. 청크는 겹쳐서 잘리므로 원문을 그대로 복원할 수 없어서 따로 보관한다.
  content text not null default '',
  uploaded_at timestamptz not null default now()
);

create table if not exists chunks (
  id serial primary key,
  document_id int not null references documents(id) on delete cascade,  -- 문서 지우면 같이 지워짐
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null        -- gemini.ts의 EMBEDDING_DIM과 반드시 일치
);

-- 코사인 거리(<=>) 검색용 인덱스
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);
```

`content`를 documents에도 따로 두는 이유: 조각들은 40어절씩 겹쳐 있어서 이어 붙이면 중복이 생긴다.
원문 그대로를 보여줘야 하는 열람/수정 팝업(D1) 때문에 원본을 따로 보관한다.

`on delete cascade`가 없으면 문서를 지울 때 조각을 먼저 지우는 코드를 손으로 써야 하고,
빠뜨리면 주인 없는 조각이 검색에 계속 걸린다.

---

# 4. 흐름 B — 질문하기

## B1. 질문 받고 자리 잡기

상황: 질문이 들어와 검증하고 처리 슬롯을 얻는 중
파일: server/routes/chat.ts

```js
const TOP_K = 5;                        // 근거로 쓸 조각 개수
const MAX_QUESTION_LENGTH = 500;
// 이 값보다 유사도가 낮으면 문서에 없는 질문으로 보고 답변을 거절한다.
// 샘플 문서 기준 관련 질문은 0.66~0.74, 무관 질문은 0.52~0.59로 갈려 그 사이인 0.62.
const THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD || 0.62);

router.post("/", async (req, res) => {
  const question = (req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "질문을 입력해주세요." });
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({ error: `질문은 ${MAX_QUESTION_LENGTH}자 이하로 입력해주세요.` });
  }

  // [과부하 제어] 자리를 못 얻으면 무한 대기 대신 즉시 429로 거절한다(load shedding).
  // 검증(빈 질문·길이)은 이 앞에서 처리한다 — 잘못된 요청이 처리 슬롯을 잡아먹지 않게.
  const admitted = await acquire();
  if (!admitted) {
    res.setHeader("Retry-After", "1");   // 언제 다시 오면 되는지 알려준다
    return res.status(429).json({ error: "요청이 많아 잠시 처리할 수 없어요. 잠시 후 다시 시도해주세요." });
  }
```

순서가 설계다. 검증 → 자리 획득 순이라, 빈 질문 같은 쓰레기 요청은 슬롯을 소비하지 않는다.
반대로 뒀다면 잘못된 요청 20건이 처리 상한 8개를 다 먹고 정상 요청을 밀어낸다.

## B1-b. 스트리밍 헤더 열기

상황: SSE로 내려보낼 준비를 하는 중
파일: server/routes/chat.ts

```js
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");  // SSE 규약
  res.setHeader("Cache-Control", "no-cache");   // 중간 캐시가 스트림을 모아두지 않게
  res.setHeader("Connection", "keep-alive");    // 연결을 끊지 않고 계속 씀
  res.flushHeaders?.();                         // 헤더를 즉시 내보내 클라이언트가 읽기 시작하게

  // SSE 한 덩어리 = "data: {...}\n\n". 빈 줄 두 개가 이벤트 끝 표시.
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const started = Date.now();               // 응답 시간 측정 시작
```

`res.json()`을 쓰면 한 번 보내고 끝난다. 스트리밍은 `res.write()`를 여러 번 하고
마지막에 `res.end()`로 닫는 방식이라 응답 형태부터 다르다.

## B2. 질문을 숫자로 (캐시 경유)

상황: 검색하려면 질문도 같은 공간의 벡터여야 하는 자리
파일: server/gemini.ts

```js
export async function embedQuery(text) {
  // 같은 질문이면 캐시된 벡터를 그대로 쓴다 → 임베딩 API 호출을 건너뜀.
  // 문서 저장(RETRIEVAL_DOCUMENT)은 한 번뿐이라 캐싱 이득이 없고,
  // 질문(RETRIEVAL_QUERY)은 반복되므로 여기만 캐싱한다.
  const key = "q:" + text;              // 접두사를 붙여 다른 용도 키와 안 섞이게
  const cached = getCached(key);
  if (cached) return cached;

  const [vector] = await embedTexts([text], "RETRIEVAL_QUERY");  // 1개 보냈으니 1개 옴 → 구조분해
  setCached(key, vector);
  return vector;
}
```

`taskType`이 문서와 질문에서 다른 이유: 임베딩 모델은 "이건 저장될 문단"과 "이건 찾으러 온 질문"을
다르게 인코딩한다. 둘 다 RETRIEVAL_DOCUMENT로 넣으면 문서끼리는 잘 맞아도 질문↔문서 매칭이 흐려진다.

## B3. 가까운 조각 5개 찾기

상황: 질문 벡터로 DB에서 이웃을 뜨는 중. 이 프로젝트의 심장
파일: server/routes/chat.ts

```js
    const queryEmbedding = await embedQuery(question);

    // <=>는 pgvector의 코사인 거리 연산자. 거리가 작을수록 비슷하다.
    // 읽기 풀 사용 — 이 경로가 사수 대상(질문 응답)이라 쓰기와 격리한다.
    const { rows } = await readPool.query(
      `select c.content, d.filename,
              1 - (c.embedding <=> $1::vector) as similarity   -- 거리를 유사도로 뒤집는다
         from chunks c
         join documents d on d.id = c.document_id              -- 파일명을 붙이려고 조인
        order by c.embedding <=> $1::vector                    -- 가까운 순
        limit $2`,
      [JSON.stringify(queryEmbedding), TOP_K]
    );

    const topSimilarity = rows[0]?.similarity ?? 0;   // 결과가 없으면 0
```

데이터 모양: `[0.1, ...768]` → `"[0.1,...]"` → `rows = [{content, filename, similarity}, ...5개]`

거리와 유사도는 반대다. 거리 0 = 완전히 같음 = 유사도 1.
그래서 `1 - 거리`로 뒤집는다. 화면에는 "유사도 0.74"처럼 클수록 좋은 값이 자연스럽다.

`order by`에 인덱스와 같은 연산자(`<=>`)를 써야 HNSW 인덱스를 탄다.
다른 연산자(`<->` 유클리드 등)를 쓰면 인덱스를 못 쓰고 전체를 훑는다.

## B4. 멀면 거절 (LLM을 부르지 않는다)

상황: 검색 결과가 엉뚱한지 판단하는 게이트
파일: server/routes/chat.ts

```js
    // [부하 감소 + 헛소리 방지] 유사도가 낮으면 LLM을 아예 부르지 않고 거절한다.
    if (rows.length === 0 || topSimilarity < THRESHOLD) {
      send({ type: "refusal", message: "업로드된 문서에서 관련 내용을 찾지 못했어요. 질문을 바꿔보시거나 관련 문서를 올려주세요." });
      res.end();
      logQuery({ question, refused: true, topSimilarity, latencyMs: Date.now() - started });
      return;                                  // 여기서 끝. 아래 생성 코드로 안 감
    }
```

이 게이트가 없으면 어떤 질문에도 top 5 조각은 나온다. 벡터 검색은 "가장 가까운 것"을 주지
"충분히 가까운 것"을 주지 않는다. "프랑스 수도?"에도 환불 정책 조각이 1등으로 나오고,
LLM은 그걸 근거랍시고 받아 그럴듯한 헛소리를 만든다.

임계값은 찍은 게 아니라 재서 정했다. 샘플 문서로 관련 질문 유사도(0.66~0.74)와
무관 질문 유사도(0.52~0.59)를 각각 측정하고 그 사이(0.62)를 잡았다.
문서가 바뀌면 `query_logs.top_similarity`를 보고 다시 맞춘다.

```sql
select question, refused, top_similarity from query_logs order by id desc limit 20;
```

## B5. 근거를 먼저 보내기

상황: 답변보다 출처를 앞세우는 자리
파일: server/routes/chat.ts

```js
    // 답변보다 근거를 먼저 보낸다 (스트리밍 중에도 출처가 보이고, degrade 시에도 남는다)
    send({
      type: "sources",
      sources: rows.map((r, i) => ({
        index: i + 1,                                  // [1], [2] 번호 (1부터)
        filename: r.filename,
        snippet: r.content.slice(0, 100),              // 미리보기 100자만
        similarity: Math.round(r.similarity * 100) / 100,  // 소수 둘째 자리로 반올림
      })),
    });
```

`Math.round(x * 100) / 100`은 소수 2자리 반올림 관용구다. 0.7361 → 73.61 → 74 → 0.74.

순서가 설계인 두 번째 자리다. 출처를 먼저 보내두면, 아래에서 LLM이 실패해 대체 응답으로 빠져도
사용자 화면에는 이미 출처가 떠 있다. 이게 C5(graceful degradation)를 성립시키는 전제다.

## B6. 답을 조각조각 전송

상황: LLM 스트림을 받아 그대로 흘려보내는 중
파일: server/routes/chat.ts

```js
    // [회로차단] LLM이 최근 연속 장애면 회로가 열려 있다 → 부르지도 않고 바로 대체 응답.
    if (breaker.isOpen()) {
      degrade();
      res.end();
      logQuery({ question, answer: "(degraded: breaker open)", refused: false, topSimilarity, latencyMs: Date.now() - started });
      return;
    }

    let answer = "";
    let usage = null;
    try {
      const stream = await streamAnswer(question, rows);
      for await (const chunk of stream) {        // 비동기 반복 — 조각이 도착할 때마다 한 바퀴
        if (chunk.text) {
          answer += chunk.text;                  // DB 로그용으로 전문을 모아둔다
          send({ type: "delta", text: chunk.text });   // 동시에 화면으로 흘려보낸다
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;  // 토큰 정보는 보통 마지막 조각에
      }
      breaker.onSuccess();                       // 성공 → 회로 카운터 리셋
    } catch (llmErr) {
      breaker.onFailure();                       // 실패를 회로에 기록
      degrade();                                 // 그리고 우아하게 물러난다
      res.end();
      logQuery({ question, answer: "(degraded: llm error)", refused: false, topSimilarity, latencyMs: Date.now() - started });
      return;
    }
```

`for await`는 배열이 아니라 "아직 안 온 것도 기다리며 도는" 반복문이다.
일반 `for...of`로는 아직 도착하지 않은 조각을 기다릴 수 없다.

`answer`를 모으는 이유와 `send`를 동시에 하는 이유가 다르다.
전자는 DB(query_logs)에 남기려고, 후자는 화면에 흘리려고. 한 번 도는 김에 둘 다 한다.

## B6-b. 프롬프트 조립

상황: 검색된 조각들을 LLM이 읽을 형태로 묶는 중
파일: server/gemini.ts

```js
export async function streamAnswer(question, contexts) {
  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (출처: ${c.filename})\n${c.content}`)   // 번호를 붙여야 인용이 가능
    .join("\n\n");

  const prompt = `당신은 사용자가 업로드한 문서를 근거로 답하는 어시스턴트입니다.

규칙:
- 아래 발췌 내용만 근거로 답합니다. 발췌에 없는 내용은 추측하지 말고 문서에 없다고 답하세요.
- 근거로 사용한 발췌 번호를 문장 끝에 [1], [2] 형태로 표시하세요.
- 한국어로 간결하게 답하세요.
- 굵게(**), 제목(#), 별표 목록(*) 같은 마크다운 서식은 쓰지 마세요.

발췌:
${contextBlock}

질문: ${question}`;
```

발췌에 `[1]` 번호를 붙이는 게 핵심이다. 번호가 없으면 LLM이 "몇 번 발췌를 썼는지" 말할 방법이 없고,
화면에서 본문의 인용과 출처 카드를 연결할 수도 없다. B5에서 보낸 `index`와 같은 번호다.

마크다운 금지 규칙을 넣어도 LLM이 가끔 어긴다. 그래서 화면에서 한 번 더 걷어낸다(D3).
프롬프트는 부탁이지 보장이 아니라는 걸 전제로 짠다.

## B6-c. 스트림 열기와 재시도의 경계

상황: 생성 API를 부르는 자리. 어디까지 재시도할 수 있는지가 갈리는 지점
파일: server/gemini.ts

```js
  // 스트림을 여는 것까지만 재시도한다. 일단 토큰이 흘러나오기 시작하면
  // (chat.ts에서 for await로 소비) 중간에 재시도할 수 없다.
  return withRetry(
    () => ai.models.generateContentStream({ model: CHAT_MODEL, contents: prompt }),
    "생성"
  );
```

이유: 이미 "환불은 영업일 기준"까지 화면에 흘려보낸 뒤에 재시도하면
처음부터 다시 나오는 답이 이어붙어 문장이 두 번 나온다. 되돌릴 수 없는 지점을 넘긴 것이다.
재시도는 부작용이 없는 구간(스트림을 열기 전)에만 안전하다.

## B6-d. 로그는 응답 경로 밖으로

상황: 응답을 끝낸 뒤 관측 기록을 남기는 중
파일: server/routes/chat.ts

```js
// 질문 로그(관측용)를 사용자 응답 경로에서 빼서 백그라운드로 쓴다.
// 로그를 기다리느라 사용자 응답이 늦을 이유가 없고, 부하 때 요청당 DB 왕복을 하나 줄인다.
function logQuery(row) {
  const { question, answer = null, refused, topSimilarity, promptTokens = null, outputTokens = null, latencyMs } = row;
  // 로그는 쓰기 풀로. 로그가 몰려도 질문 검색(읽기 풀)은 영향받지 않는다.
  writePool
    .query(
      `insert into query_logs
         (question, answer, refused, top_similarity, prompt_tokens, output_tokens, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [question, answer, refused, topSimilarity, promptTokens, outputTokens, latencyMs]
    )
    .catch((e) => console.error("query_logs insert 실패:", e.message));  // await 안 함 → 안 기다림
}
```

`await`가 없는 게 핵심이다. `.catch()`만 붙여둔다.
`await`를 붙이면 사용자는 로그가 DB에 쓰일 때까지 기다린다. 로그는 사용자 것이 아니라 우리 것이다.

`.catch()`를 빠뜨리면 안 된다. await 없는 Promise가 거부되면 Node에서 unhandled rejection이 되고,
버전에 따라 프로세스가 죽는다. 로그 실패로 서버가 내려가는 건 최악이다.

측정: 동시 20 연결에서 이 분리만으로 처리량 20 → 24 RPS, p99 지연 2794 → 1606ms (42% 감소).

## B7. 화면에서 받아 붙이기

상황: 브라우저가 SSE 스트림을 읽어 이벤트로 쪼개는 중
파일: web/src/api.ts

```js
// SSE 응답을 읽어서 이벤트 타입별 핸들러를 호출한다.
// EventSource는 POST를 못 보내서 fetch로 직접 파싱한다.
export async function streamChat(question, handlers) {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {                                   // 429(rate limit/과부하) 등은 여기서 걸린다
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "요청에 실패했습니다.");
  }

  const reader = res.body.getReader();             // 본문을 조각조각 읽는 리더
  const decoder = new TextDecoder();               // 이진 조각 → 문자열
  let buffer = "";                                 // 미완성 조각을 모아두는 곳
```

`EventSource`(브라우저 내장 SSE 클라이언트)를 못 쓰는 이유: GET만 보낼 수 있다.
질문을 본문에 실어 POST해야 하므로 fetch로 직접 파싱한다.

상황: 도착한 바이트를 이벤트 단위로 자르는 중. 여기가 제일 헷갈리는 자리
파일: web/src/api.ts

```js
  while (true) {
    const { done, value } = await reader.read();   // 다음 조각을 기다린다
    if (done) break;                               // 스트림 끝
    buffer += decoder.decode(value, { stream: true });  // stream:true = 글자가 반 잘려도 보관

    // 이벤트는 빈 줄(\n\n)로 구분된다. 마지막 조각은 아직 미완성일 수 있어 남겨둔다.
    const parts = buffer.split("\n\n");
    buffer = parts.pop();                          // 마지막 조각을 빼서 버퍼로 되돌린다

    for (const part of parts) {                    // 남은 건 전부 완성된 이벤트
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5));     // "data:" 5글자 떼고 JSON 해석
      handlers[event.type]?.(event);               // 타입별 처리 (sources/delta/refusal/done/error)
    }
  }
}
```

`parts.pop()`이 핵심이다. 네트워크는 `data: {"type":"delta","te` 처럼 중간에서 끊어 보낸다.
`split("\n\n")`의 마지막 조각은 "아직 `\n\n`을 못 만난 것"이라 완성 보장이 없다.
그래서 마지막만 빼서 버퍼에 되돌리고, 다음 read에서 뒤를 이어붙인다.

`pop()`은 마지막 항목을 꺼내면서 원본을 짧게 만든다. 한 줄로 "빼기 + 남기기"가 동시에 된다.

데이터 모양:
```
바이트 조각        "data: {\"type\":\"delta\",\"te"
  ↓ buffer에 누적   "data: {\"type\":\"delta\",\"te"
  ↓ split("\n\n")   ["data: {\"type\":\"delta\",\"te"]   ← 완성된 게 없음
  ↓ pop()           parts=[] , buffer="data: {...te"     ← 전부 되돌림
다음 조각 도착      "xt\":\"환불\"}\n\n"
  ↓ buffer 누적     "data: {\"type\":\"delta\",\"text\":\"환불\"}\n\n"
  ↓ split           ["data: {...환불...}", ""]
  ↓ pop()           parts=["data: {...환불...}"] , buffer=""
  ↓ 처리            handlers.delta({type:"delta", text:"환불"})
```

---

# 5. 흐름 C — 방어 레이어

요청 하나가 거치는 순서다. 앞쪽일수록 싸고, 뒤로 갈수록 이미 자원을 쓴 상태다.

```
요청 → C1 사용자별 제한 → C2 동시 처리 상한 → C3 풀 격리 → C4 회로차단 → C5 대체 응답
       (한 명의 폭주)     (전체 과부하)       (한쪽 포화)   (외부 장애)   (그래도 실패)
```

각 층이 막는 문제가 다르다. 하나로 다 못 막기 때문에 층을 쌓는다.

## C1. 사용자별 요청 제한 (Token Bucket)

상황: 한 IP가 초당 수백 건을 쏘는 걸 가장 앞단에서 잘라내는 중
파일: server/ratelimit.ts

```js
const CAPACITY = Number(process.env.RL_CAPACITY || 10);      // 버킷 용량 = 순간 허용 버스트
const REFILL_PER_SEC = Number(process.env.RL_REFILL || 5);   // 초당 채워지는 토큰 = 평균 허용 속도

const buckets = new Map();   // ip -> { tokens, last }
let rejected = 0;            // 관측용: 지금까지 거절한 요청 수

export function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: CAPACITY, last: now };   // 처음 온 IP는 가득 찬 버킷을 받는다
    buckets.set(ip, b);
  }

  // 지난 시간만큼 토큰을 채운다 (최대 CAPACITY까지)
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.last = now;

  if (b.tokens < 1) {
    rejected++;
    const waitSec = Math.ceil((1 - b.tokens) / REFILL_PER_SEC);
    res.setHeader("Retry-After", String(waitSec));    // 언제 오면 되는지 알려준다
    return res.status(429).json({ error: "요청이 너무 잦아요. 잠시 후 다시 시도해주세요." });
  }

  b.tokens -= 1;    // 토큰 하나 소비하고 통과
  next();
}
```

타이머로 토큰을 채우지 않는 게 요령이다. IP마다 타이머를 돌리면 IP 수만큼 타이머가 생긴다.
대신 `last`(마지막으로 본 시각)만 기록해뒀다가, 요청이 올 때 "그동안 얼마나 찼겠나"를 계산한다.
이걸 lazy refill이라 부른다. 계산은 곱셈 한 번이라 사실상 공짜다.

왜 Token Bucket인가 (대안 비교):

| 방식 | 문제 |
|---|---|
| 고정 윈도우 카운터 | 윈도우 경계에서 순간적으로 한도의 2배가 몰리는 허점 |
| 무조건 즉시 거절 | 사람은 원래 몰아서 보내는데(연타) 정상 버스트까지 막혀 불편 |
| Token Bucket | 용량만큼 버스트 허용 + 충전 속도로 평균 제한. 둘 다 만족 |

상황: 안 쓰는 버킷이 메모리에 쌓이는 걸 막는 중
파일: server/ratelimit.ts

```js
// 오래 안 쓴 버킷을 주기적으로 청소해 메모리 누수를 막는다.
// unref()로 이 타이머가 프로세스 종료를 붙잡지 않게 한다.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now - b.last > 10 * 60 * 1000) buckets.delete(ip);   // 10분 유휴면 제거
  }
}, 60 * 1000);
sweep.unref?.();
```

`unref()`가 없으면 이 setInterval이 이벤트 루프를 붙잡아서 `node --test`가 안 끝난다.
"이 타이머는 프로세스를 살려둘 이유가 못 된다"고 표시하는 함수다.

상황: 이 미들웨어만 따로 검증하는 중. 실제 서버·HTTP 없이 함수만 부른다
파일: server/ratelimit.test.ts

```js
// 설정은 모듈 로드 시점에 환경변수로 읽히므로, import 전에 값을 정한다.
// (node --test는 파일마다 별도 프로세스로 돌려서 파일 간 환경변수가 안 섞인다.)
process.env.RL_CAPACITY = "3";
process.env.RL_REFILL = "5";                    // 초당 5개 → 200ms에 1개

const { rateLimit, rateLimitStats } = await import("./ratelimit.ts");   // 정적 import가 아닌 동적 import

// 미들웨어를 한 번 태우고 통과 여부와 응답을 돌려준다.
function hit(ip) {
  const res = fakeRes();                        // res.status/json/setHeader만 흉내낸 가짜 객체
  let passed = false;
  rateLimit({ ip, socket: { remoteAddress: ip } }, res, () => { passed = true; });  // next()가 불리면 통과
  return { passed, res };
}

test("시간이 지나면 토큰이 충전돼 다시 통과한다", async () => {
  Array.from({ length: 5 }, () => hit("10.0.0.4"));    // 소진
  assert.equal(hit("10.0.0.4").passed, false, "소진 직후엔 막힌다");

  await sleep(300);                                     // 초당 5개 충전 → 300ms면 1개 이상 회복

  assert.equal(hit("10.0.0.4").passed, true, "충전 뒤엔 다시 통과");
});
```

`import` 문은 파일 맨 위로 끌어올려져서 `process.env` 설정보다 먼저 실행된다.
그래서 설정을 반영하려면 `await import(...)`(동적 import)를 써야 한다. 이건 외울 것.

## C2. 동시 처리 상한 + 대기 데드라인

상황: 전체 트래픽이 처리 능력을 넘었을 때 일부를 빨리 포기하는 중
파일: server/admission.ts

```js
let inFlight = 0;      // 지금 처리 중인 요청 수
const waiters = [];    // 자리를 기다리는 요청들

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 8);            // 동시 처리 상한
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20);                 // 대기열 길이 상한
const MAX_QUEUE_WAIT_MS = Number(process.env.MAX_QUEUE_WAIT_MS || 2000); // 대기열 시간 상한

// 자리를 얻으면 true, 과부하로 거절되면 false.
export function acquire() {
  if (inFlight < MAX_INFLIGHT) {
    inFlight++;
    return Promise.resolve(true);           // 여유 있음 → 즉시 통과
  }

  if (waiters.length >= MAX_QUEUE) {
    rejected++;
    return Promise.resolve(false);          // 대기열까지 꽉 참 → 즉시 거절 (load shedding)
  }

  return new Promise((resolve) => {         // 그 사이 → 대기열에 담는다
    const w = { resolve, settled: false, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1);    // 큐에서 빼고
      timedOut++;
      settle(w, false);                      // 기다리길 포기 → 429
    }, MAX_QUEUE_WAIT_MS);
    waiters.push(w);
  });
}
```

`new Promise`를 만들고 `resolve`를 큐에 넣어두는 게 핵심 기법이다.
이 Promise는 나중에 누가 `resolve(true)`를 불러줄 때까지 완료되지 않는다.
호출한 쪽(`await acquire()`)은 그동안 멈춰 서 있다. "요청을 세워두기"가 이렇게 구현된다.

왜 길이 상한만으로 부족한가:
대기열 길이에 상한을 둬도, 앞의 요청들이 오래 걸리면 큐 안에서 무한정 기다릴 수 있다.
"무한 대기를 없앴다"고 말하려면 길이뿐 아니라 시간에도 상한이 있어야 한다.
그래서 데드라인(2초)을 두고, 그 안에 자리가 안 나면 포기하고 429로 돌려보낸다.
어차피 그때쯤이면 사용자도 떠났고, 늦게 처리해봐야 아무도 안 받아가는 응답에 자원만 쓰는 셈이다.

상황: 두 곳에서 같은 대기자를 깨우려 할 때 한 번만 이기게 하는 자리
파일: server/admission.ts

```js
// 대기자는 타임아웃과 release() 양쪽에서 깨울 수 있다.
// 먼저 도착한 쪽만 이기고 나머지는 무시되도록 한 번만 확정한다.
function settle(w, value) {
  if (w.settled) return false;     // 이미 확정됐으면 아무 일도 안 함
  w.settled = true;
  clearTimeout(w.timer);           // 남은 타이머 정리 (안 하면 나중에 헛불림)
  w.resolve(value);
  return true;
}
```

`settled` 플래그가 없으면 이런 일이 난다: 타임아웃이 걸려 429로 돌려보낸 대기자에게
직후 `release()`가 자리를 넘겨준다. 자리는 나갔는데 받아 쓸 사람이 없어 슬롯이 새어나간다.

상황: 처리가 끝나 자리를 넘겨주는 중
파일: server/admission.ts

```js
export function release() {
  // 앞에서부터 아직 살아 있는 대기자를 찾아 자리를 넘긴다.
  // (타임아웃된 대기자는 이미 큐에서 빠졌지만, 경합에 대비해 방어적으로 건너뛴다.)
  while (waiters.length > 0) {
    const next = waiters.shift();
    if (settle(next, true)) return;   // 자리 양보 — inFlight는 그대로 유지
  }
  inFlight--;                          // 기다리는 사람이 없으면 자리를 비운다
}
```

대기자에게 넘길 때 `inFlight`를 건드리지 않는 게 포인트다.
감소시켰다 증가시키면 그 찰나에 다른 요청이 끼어들어 상한을 넘길 수 있다.
"자리를 비웠다가 다시 채운다"가 아니라 "바통을 직접 넘긴다".

상황: 호출 쪽에서 자리를 반드시 반납하게 만드는 자리
파일: server/routes/chat.ts

```js
  } finally {
    release();   // 성공·실패·거절 무엇이든 자리는 반드시 반납
  }
```

`finally`가 아니라 성공 경로에만 `release()`를 두면, 예외 한 번에 슬롯이 영구히 샌다.
8번 새면 서버가 조용히 멈춘다. 자원 반납은 항상 `finally`.

## C3. 읽기/쓰기 풀 격리 (Bulkhead)

상황: 커넥션 풀을 용도별로 나누는 중
파일: server/db.ts

```js
// Bulkhead(자원 풀 격리) — 배의 방수격벽처럼 커넥션 풀을 용도별로 나눈다.
//
// 왜: 한 종류의 작업이 커넥션을 다 먹어버리면 다른 작업까지 멈춘다.
// 문서 업로드나 로그 쓰기(느리고 몰릴 수 있음)가 커넥션을 독차지하면,
// 정작 사용자 질문(검색)이 커넥션을 못 얻어 챗봇 전체가 멈추는 상황이 생긴다.

const common = {
  connectionString,
  idleTimeoutMillis: 30000,        // 놀고 있는 연결은 30초 뒤 반납
  connectionTimeoutMillis: 5000,   // 5초 안에 연결 못 얻으면 실패 (무한 대기 방지)
};

// 사용자 질문 경로(검색). 사수해야 하는 핵심이라 넉넉히.
export const readPool = new pg.Pool({ ...common, max: Number(process.env.PG_READ_MAX || 10) });

// 업로드·로그 쓰기. 여기가 포화돼도 읽기(질문)는 영향받지 않는다.
export const writePool = new pg.Pool({ ...common, max: Number(process.env.PG_WRITE_MAX || 5) });
```

`connectionTimeoutMillis`가 없으면 풀이 마르는 순간 요청들이 무한정 매달린다.
타임아웃이 있어야 "이 요청은 실패"로 빨리 결론이 나고, 매달린 요청이 메모리를 먹지 않는다.

방수격벽 비유가 맞는 지점: 배 한 칸에 물이 차도 다른 칸은 마른 채로 남아 배가 안 가라앉는다.
쓰기 풀 5개가 다 차도 읽기 풀 10개는 그대로라 질문은 계속 처리된다.

누가 어느 풀을 쓰는지가 전부다:

| 경로 | 풀 | 이유 |
|---|---|---|
| 질문 벡터 검색 (chat.ts) | readPool | 사수 대상 |
| 문서 업로드·수정·삭제·조회 (documents.ts) | writePool | 관리 경로, 느려도 됨 |
| query_logs 쓰기 (chat.ts의 logQuery) | writePool | 우리 것, 사용자 것 아님 |

## C4. LLM 회로 차단 (Circuit Breaker)

상황: 외부 API가 죽었을 때 계속 두들기지 않게 막는 중
파일: server/breaker.ts

```js
let consecutiveFailures = 0;
let openUntil = 0;    // 이 시각까지 회로가 열려 있음 (epoch ms)

const THRESHOLD = Number(process.env.BREAKER_THRESHOLD || 5);          // 연속 실패 몇 번에 열까
const COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 10000);  // 얼마나 열어둘까

// 지금 회로가 열려 있나(= LLM을 건너뛸까).
export function isOpen() {
  return Date.now() < openUntil;      // 시각 비교만. 타이머 없이 자동으로 닫힌다
}

export function onSuccess() {
  consecutiveFailures = 0;            // 한 번 성공하면 카운터 리셋
}

export function onFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= THRESHOLD) {
    openUntil = Date.now() + COOLDOWN_MS;   // 회로 열기
  }
}
```

상태를 "열림/닫힘 플래그"가 아니라 "언제까지 열림(openUntil)"으로 잡은 게 요령이다.
플래그로 하면 닫는 타이머를 따로 돌려야 하고, 그 타이머가 프로세스를 붙잡거나 새기 쉽다.
시각 비교면 부를 때마다 저절로 판정된다.

"연속" 실패라는 점이 중요하다. 누적이면 서버가 오래 살아 있을수록 언젠가는 반드시 열린다.
가끔 나는 실패는 장애가 아니다. 연속 5번이어야 "지금 저쪽이 죽었다"는 신호가 된다.

상황: 쿨다운이 끝난 직후를 검증하는 중. half-open을 안 만든 이유가 여기 있다
파일: server/breaker.test.ts

```js
test("쿨다운 직후 한 번만 더 실패해도 즉시 다시 열린다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  await sleep(120);                                  // 쿨다운 80ms보다 길게
  assert.equal(breaker.isOpen(), false);

  // 실패 카운터는 남아 있으므로, 탐색 요청 한 번이 실패하면 바로 재차단된다.
  // half-open 상태를 따로 두지 않고도 "아직 안 나았으면 곧바로 다시 닫는" 효과.
  breaker.onFailure();

  assert.equal(breaker.isOpen(), true, "회복 안 됐으면 곧장 다시 열려야 한다");
});
```

교과서 회로차단기는 closed / open / half-open 3상태다.
여기서는 쿨다운 후 카운터를 리셋하지 않는 것만으로 half-open과 같은 효과를 낸다.
상태 하나를 덜 만들어 코드가 짧아지고, 대신 "다음 실패 한 번에 즉시 재차단"이라는 규칙을 얻는다.

측정 (LLM에 "300ms 매달렸다 실패하는" 장애를 주입하고 9번 요청):
```
#1~4  degraded  약 500ms   breaker closed (연속실패 1→4)
#5    degraded  약 500ms   breaker OPEN  (연속실패 5 → 회로 열림)
#6~9  degraded  약 190ms   breaker OPEN  (LLM 안 부름 → 지연 뚝 떨어짐)
```
회로가 열린 뒤 지연이 500ms에서 190ms로 떨어졌다. 이게 "느린 실패 → 즉시 대체"의 값이다.

## C5. 실패해도 출처는 준다 (Graceful Degradation)

상황: LLM을 못 쓰는 상황에서 사용자에게 뭘 줄지 정하는 자리
파일: server/routes/chat.ts

```js
// [degradation] LLM을 못 쓰는 상황에서도 사용자를 빈손으로 두지 않는다.
// 출처(sources)는 이미 보냈으니, 답변 생성만 포기하고 그 사실을 알린다.
const degrade = () => {
  send({ type: "delta", text: "지금 답변 생성이 어려워요. 위 출처 문서를 직접 확인해주세요." });
  send({ type: "done", usage: { promptTokens: null, outputTokens: null } });
};
```

`type: "delta"`로 보내는 이유: 화면(D2)이 delta를 이미 "답변 본문에 이어붙이기"로 처리한다.
새 이벤트 타입을 만들면 화면에도 분기를 추가해야 한다. 기존 통로를 재사용해 양쪽 다 안 늘린다.

`type: "done"`으로 정상 종료 신호를 보내는 것도 의도다. 화면 입장에서 이건 에러가 아니라
"답변이 짧게 끝난 것"이다. 빨간 에러 상자 대신 평범한 말풍선으로 보인다.

degrade가 불리는 자리는 두 곳이고 의미가 다르다:

| 자리 | 언제 | 지연 |
|---|---|---|
| `breaker.isOpen()` 직후 | 이미 회로가 열려 있음 | 빠름 (LLM 안 부름) |
| `catch (llmErr)` | 이번 요청이 실제로 실패 | 느림 (재시도까지 소진) |

전자가 후자를 대신하게 만드는 게 회로차단기의 목적이다.

## C6. 질문 임베딩 캐시

상황: 같은 질문에 매번 임베딩 API를 부르지 않게 하는 중
파일: server/cache.ts

```js
const cache = new NodeCache({
  stdTTL: 600,        // 10분 지나면 만료 (문서가 바뀌면 임베딩도 달라질 수 있어 무한 보관은 안 함)
  maxKeys: 5000,      // 메모리 상한. 초과하면 set이 에러를 던지므로 아래에서 삼킴
  checkperiod: 120,   // 2분마다 만료된 키 청소
});

export function setCached(key, value) {
  try {
    cache.set(key, value);
  } catch {
    // maxKeys 초과 시 던지는 에러는 무시한다. 캐시는 있으면 좋고 없어도 되는 것이라,
    // 캐시가 꽉 찼다고 실제 요청을 실패시키면 안 된다.
  }
}
```

빈 `catch {}`는 보통 나쁜 습관인데 여기서는 의도적이다.
캐시는 성능 장치지 정확성 장치가 아니다. 실패하면 원래 경로(API 호출)로 돌아가면 그만이다.
그 판단을 주석으로 남겨야 나중에 "여기 에러 처리 빠졌네" 하고 오해받지 않는다.

함수 세 개(get/set/stats)만 노출한 이유:
지금은 서버가 한 대라 인메모리로 충분하다. 여러 대로 늘리면 인스턴스마다 캐시가 따로 놀아
적중률이 떨어지므로 Redis 같은 공유 캐시로 바꿔야 한다.
그때 이 세 함수의 속만 갈아끼우면 부르는 쪽(gemini.ts)은 한 줄도 안 바뀐다.

측정: 실제 Gemini로 캐시 미스 1197ms, 캐시 히트 0.05ms. 반복 질문에서 질문당 1초가 사라진다.

## C7. 상태를 밖으로 노출하기

상황: 방어 레이어들이 지금 뭘 하고 있는지 한 곳에 모으는 중
파일: server/index.ts

```js
// 방어 레이어들의 상태를 한눈에 노출한다.
// 모니터링이 곧 결정력 — 장애 상황에서 어느 레이어가 발동했는지 몇 초 안에
// 파악하려면 이 값들이 보여야 한다. (프로덕션은 Prometheus + Grafana)
app.get("/api/metrics", (req, res) => {
  const s = cacheStats();
  const total = s.hits + s.misses;
  res.json({
    cache: { hits: s.hits, misses: s.misses, hitRate: total ? Math.round((s.hits / total) * 100) / 100 : 0, keys: s.keys },
    // Bulkhead: 읽기(질문)와 쓰기(업로드·로그) 풀을 따로 노출.
    readPool:  { total: readPool.totalCount,  idle: readPool.idleCount,  waiting: readPool.waitingCount },
    writePool: { total: writePool.totalCount, idle: writePool.idleCount, waiting: writePool.waitingCount },
    rateLimit: rateLimitStats(),   // 사용자별 제한: 거절 수, 활성 버킷 수
    admission: admissionStats(),   // 과부하 제어: 처리 중/대기 수
    breaker: breakerState(),       // 회로차단: 열림 여부, 연속 실패 수
    faults,                        // 현재 주입된 장애 상태 (llmFail)
  });
});
```

`total ? ... : 0`이 필요한 이유: 요청이 하나도 없으면 hits/misses가 둘 다 0이라
나눗셈이 `0/0 = NaN`이 된다. JSON에 NaN이 들어가면 `null`로 직렬화돼 화면이 깨진다.

각 모듈이 `xxxStats()`를 스스로 내놓는 구조라, 내부 변수(`buckets`, `inFlight`)를
밖으로 열지 않고도 관측할 수 있다. 새 레이어를 추가하면 여기 한 줄만 늘어난다.

## C8. 장애 주입 스위치와 그 보호

상황: 데모용으로 LLM을 고의로 죽이는 스위치를 만드는 중
파일: server/faults.ts

```js
// 런타임 장애 주입 스위치.
// 대시보드 버튼으로 껐다 켤 수 있게, 환경변수(고정)가 아니라 이 가변 객체를 본다.
export const faults = {
  llmFail: process.env.LLM_FAIL === "1",   // 시작값은 환경변수, 이후 런타임에 토글
};
```

객체로 내보내는 이유: `export let llmFail = false`로 하면 import한 쪽은 값 복사본을 보게 되고,
나중에 바꿔도 반영되지 않는다. 객체의 속성이면 같은 객체를 참조하니 바로 반영된다.

상황: 그 스위치가 켜졌을 때 실제로 실패하는 자리
파일: server/gemini.ts

```js
  // 죽은 의존성이 타임아웃까지 매달리는 상황을 흉내내려고 잠깐 지연 후 던진다.
  // 이래야 회로차단기가 열렸을 때(즉시 실패)와 안 열렸을 때(느린 실패)의
  // 지연 차이가 드러난다.
  if (faults.llmFail) {
    await new Promise((r) => setTimeout(r, 300));
    const e = new Error("mock LLM 장애");
    e.status = 503;                    // 503이라 withRetry가 재시도까지 한다 (진짜 장애처럼)
    throw e;
  }
```

즉시 던지면 "실패가 느리다"는 문제 자체가 재현되지 않아서 회로차단기가 왜 필요한지 안 보인다.
300ms 지연이 데모의 핵심이다.

상황: 그 스위치가 배포 서버에서 공개되지 않게 막는 중
파일: server/admin.ts

```js
// 결정: "기본적으로 안전하게(secure by default)" 두 단계로 막는다.
// - ADMIN_TOKEN이 설정돼 있으면: 토큰이 일치해야만 통과 (배포 환경)
// - 설정돼 있지 않으면: 루프백(localhost)에서 온 요청만 통과 (로컬 데모)

export function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    if (!tokenMatches(req.get("x-admin-token"))) {
      return res.status(401).json({ error: "관리자 토큰이 필요합니다." });
    }
    return next();
  }

  if (!isLoopback(req)) {
    return res.status(403).json({ error: "관리자 기능은 로컬에서만 사용할 수 있습니다. ..." });
  }
  return next();
}
```

설정을 깜빡했을 때 열리는 게 아니라 잠기는 쪽이 기본값이다.
"토큰 없으면 통과"로 짰다면 배포 후 토큰 설정을 잊는 순간 아무나 서비스를 망가뜨릴 수 있다.

```js
// req.ip는 trust proxy가 켜져 있으면 X-Forwarded-For를 따르는데, 그 헤더는
// 클라이언트가 마음대로 넣을 수 있어 인증 판단에 쓰면 안 된다.
function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";     // 실제 TCP 피어 주소
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
```

같은 프로젝트 안에서 `req.ip`(C1 rate limit)와 `req.socket.remoteAddress`(여기)를
의도적으로 다르게 쓴다. rate limit은 "누구를 세는가"라 프록시 뒤 실제 IP가 맞고,
인증은 "속일 수 있는 값을 쓰면 안 된다"라 조작 불가능한 TCP 주소가 맞다.

```js
// 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 거른다.
// 비교 자체는 타이밍 공격을 막기 위해 상수 시간 비교를 쓴다.
function tokenMatches(given) {
  const a = Buffer.from(given || "", "utf8");
  const b = Buffer.from(ADMIN_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

`a === b`로 비교하면 앞에서부터 틀린 지점에 도달하는 시간이 미세하게 다르다.
그 차이를 반복 측정해 한 글자씩 맞춰가는 공격이 타이밍 공격이다.
`timingSafeEqual`은 항상 끝까지 비교해서 시간이 일정하다.

---

# 6. 흐름 D — 화면

## D0. 화면 뼈대와 프록시

상황: 문서 목록이라는 상태를 어디에 둘지 정하는 자리
파일: web/src/App.tsx

```js
export default function App() {
  const [documents, setDocuments] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [view, setView] = useState("chat");           // "chat" | "dashboard"

  // useCallback으로 감싸는 이유: 아래 useEffect의 의존성 배열에 들어가는데,
  // 매 렌더마다 새 함수가 만들어지면 useEffect가 무한히 다시 돈다.
  const refresh = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
      setLoadError(null);
    } catch {
      setLoadError("문서 목록을 불러오지 못했습니다. 서버와 DB가 켜져 있는지 확인해주세요.");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);          // 처음 한 번 불러오기
```

`documents`를 App에 두는 이유: Sidebar(목록 표시)와 Chat(문서가 없으면 안내문)이 둘 다 쓴다.
둘 중 하나에 두면 형제 컴포넌트로 내려보낼 방법이 없다. 공통 부모까지 올린다.

`refresh`를 Sidebar에 `onChanged`로 내려주는 것도 같은 이유다.
업로드/삭제는 Sidebar에서 일어나지만 상태는 App에 있으니, 바뀌었다고 알릴 통로가 필요하다.

상황: 프론트(5173)와 서버(4000)를 같은 주소처럼 쓰는 자리
파일: web/vite.config.ts

```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',   // /api로 시작하는 요청은 서버로 넘긴다
    },
  },
})
```

이게 있어서 프론트 코드가 `fetch("/api/chat")`처럼 상대 경로만 쓴다.
`http://localhost:4000/api/chat`을 직접 쓰면 배포할 때 전부 고쳐야 하고, CORS도 매번 걸린다.

## D1. 사이드바 — 업로드·목록·삭제

상황: 파일 선택 버튼을 예쁘게 만들려고 진짜 input을 숨긴 자리
파일: web/src/components/Sidebar.tsx

```js
  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";      // 같은 파일을 다시 선택해도 change 이벤트가 오도록 비워둔다
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file);
      await onChanged();      // App의 refresh() — 목록을 다시 불러온다
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);    // 성공이든 실패든 버튼은 원래대로
    }
  }
```

```jsx
      <button className="upload-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
        {uploading ? "임베딩 처리 중..." : "문서 업로드 (txt, md)"}
      </button>
      <input type="file" ref={fileRef} accept=".txt,.md" onChange={handleFile} hidden />
```

`e.target.value = ""`가 없으면 같은 파일을 두 번 연속 고를 때 두 번째가 무시된다.
브라우저는 값이 안 바뀌면 change 이벤트를 안 쏘기 때문이다. 재현하기 어려운 버그라 미리 막아둔다.

버튼 문구를 "임베딩 처리 중..."으로 바꾸는 이유: 업로드는 청킹 + 임베딩 API까지 도는 작업이라
문서가 크면 몇 초 걸린다. 아무 표시가 없으면 사용자가 버튼을 또 누른다.

상황: 목록 항목 안의 삭제 버튼이 모달을 열어버리는 걸 막는 중
파일: web/src/components/Sidebar.tsx

```js
  async function handleDelete(e, id) {
    e.stopPropagation();      // 문서 클릭(모달 열기)으로 번지지 않게
    if (!confirm("이 문서를 삭제할까요?")) return;
    await deleteDocument(id);
    await onChanged();
  }
```

`stopPropagation()`이 없으면 삭제 버튼 클릭이 부모 `<div onClick={모달열기}>`까지 올라가서
삭제하면서 동시에 모달이 열린다. 클릭 이벤트가 부모로 거슬러 올라가는 걸 버블링이라 한다.

## D2. 채팅 — 스트리밍 상태 관리

상황: 질문을 보내고 답변 자리를 미리 만들어두는 중
파일: web/src/components/Chat.tsx

```js
  async function handleSubmit(e) {
    e.preventDefault();                 // form 기본 동작(새로고침) 막기
    const question = input.trim();
    if (!question || streaming) return; // 답변 중엔 다음 질문 금지

    setInput("");
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },   // 빈 답변 자리를 먼저 만든다
    ]);
```

빈 assistant 메시지를 미리 넣는 게 스트리밍의 요령이다.
자리가 있어야 도착하는 조각을 계속 그 자리에 이어붙일 수 있다.
자리가 없으면 첫 delta가 올 때 "새로 만들까 이어붙일까"를 매번 판단해야 한다.

상황: 도착하는 조각을 마지막 메시지에만 반영하는 중
파일: web/src/components/Chat.tsx

```js
  // 항상 마지막 메시지(스트리밍 중인 답변)를 갱신한다
  function patchLast(updater) {
    setMessages((prev) => {
      const next = prev.slice();                          // 배열 복사 (원본을 직접 고치면 리렌더 안 됨)
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }
```

```js
      await streamChat(question, {
        sources: (e) => patchLast((m) => ({ ...m, sources: e.sources })),
        delta: (e) => {
          patchLast((m) => ({ ...m, content: m.content + e.text }));   // 이어붙이기
          scrollToBottom();
        },
        refusal: (e) => patchLast((m) => ({ ...m, content: e.message, refused: true })),
        done: (e) => patchLast((m) => ({ ...m, usage: e.usage })),
        error: (e) => patchLast((m) => ({ ...m, content: e.message, error: true })),
      });
```

이 핸들러 객체가 B7의 `handlers[event.type]?.(event)`와 맞물린다.
서버가 보내는 `type` 5종이 그대로 키가 된다. 서버에 새 타입을 추가하면 여기 한 줄만 늘어난다.

`setMessages(prev => ...)`처럼 함수를 넘기는 이유: delta는 초당 수십 번 온다.
`setMessages([...messages, x])`로 쓰면 클로저에 갇힌 옛날 `messages`를 보고 덮어써서 글자가 사라진다.
함수형 갱신은 리액트가 "가장 최신 상태"를 넣어준다.

`{ ...m, content: m.content + e.text }`로 새 객체를 만드는 이유:
`m.content += e.text`로 원본을 고치면 리액트는 객체 참조가 같아서 바뀐 걸 모르고 다시 그리지 않는다.

상황: 새 글자가 나올 때마다 아래로 따라 내려가는 자리
파일: web/src/components/Chat.tsx

```js
  function scrollToBottom() {
    requestAnimationFrame(() => {          // 리액트가 DOM을 다 그린 다음 프레임에 실행
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;   // 스크롤 위치 = 전체 높이 → 맨 아래
    });
  }
```

`requestAnimationFrame` 없이 바로 스크롤하면 아직 새 글자가 DOM에 없어서
한 박자 위에서 멈춘다. "그려진 다음에 재라"고 미루는 장치다.

## D3. 말풍선 — 출처와 토큰

상황: LLM이 지시를 어기고 마크다운을 섞어 보낸 걸 걷어내는 중
파일: web/src/components/Message.tsx

```js
// LLM이 지시를 어기고 마크다운 서식을 섞어 보낼 때가 있어서,
// 화면에 그대로 노출되지 않게 볼드(**)와 줄머리 헤딩(#)을 걷어낸다.
function stripMarkdown(text) {
  return text.replace(/\*\*/g, "")          // g = 전부 (없으면 첫 번째만)
             .replace(/^#{1,6}\s+/gm, "");  // m = 여러 줄 모드. ^가 각 줄 첫머리를 뜻하게
}
```

프롬프트(B6-b)에서 이미 금지했는데도 여기서 또 막는다.
프롬프트는 확률이지 보장이 아니다. 사용자에게 `**환불**`이 그대로 보이면 안 되니 두 겹으로 막는다.

상황: 답변 위에 출처 카드를 그리는 중
파일: web/src/components/Message.tsx

```jsx
      {message.sources && (                          // sources가 아직 없으면 통째로 안 그림
        <div className="sources">
          <div className="sources-title">참고한 문서</div>
          {message.sources.map((s) => (
            <div key={s.index} className="source">   // key = 리액트가 항목을 구분하는 표식
              <div className="source-head">
                <span className="source-index">[{s.index}]</span>      // 본문 [1]과 연결되는 번호
                <span className="source-file">{s.filename}</span>
                <span className="source-sim">유사도 {s.similarity.toFixed(2)}</span>
              </div>
              <div className="source-snippet">{s.snippet}…</div>
            </div>
          ))}
        </div>
      )}

      <div className="content">
        {message.content ? stripMarkdown(message.content) : <span className="cursor">▍</span>}
      </div>
```

`content`가 비었을 때 커서(`▍`)를 보여주는 게 체감을 바꾼다.
서버는 sources를 먼저 보내고(B5) 첫 글자까지 몇백 ms가 걸리는데, 그 사이 빈 상자만 있으면
멈춘 것처럼 보인다. 출처 + 깜빡이는 커서가 "받는 중"을 알린다.

```jsx
      {message.usage?.promptTokens != null && (
        <div className="usage">
          토큰 — 입력 {message.usage.promptTokens} · 출력 {message.usage.outputTokens}
        </div>
      )}
```

`!= null`은 `!== null && !== undefined`를 한 번에 본다(느낌표 하나짜리 비교의 유일한 정당한 용례).
`if (usage.promptTokens)`로 쓰면 토큰이 0일 때도 안 보인다.
degrade 응답은 usage가 null이라 이 줄이 통째로 사라진다.

## D4. 대시보드 — 상황을 주입하고 관찰하기

상황: 1초마다 서버 상태를 긁어와 전이를 감지하는 중
파일: web/src/components/Dashboard.tsx

```js
  useEffect(() => {
    let alive = true;                          // 언마운트 후 setState를 막는 표식
    const tick = async () => {
      try {
        const data = await fetchMetrics();
        if (!alive) return;
        const p = prev.current;                // 직전 값 (useRef라 리렌더를 안 일으킴)
        if (p && !p.breaker.open && data.breaker.open) addLog("Circuit Breaker 열림 — LLM 연속 실패 감지", "danger");
        if (p && p.breaker.open && !data.breaker.open) addLog("Circuit Breaker 닫힘 — 정상 복구", "ok");
        prev.current = data;
        setM(data);
        setFaultOn(!!data.faults?.llmFail);
      } catch {
        /* 서버 꺼짐 등은 무시 */
      }
    };
    tick();                                    // 첫 실행은 즉시 (1초 기다리지 않게)
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };   // 화면을 떠나면 정리
  }, []);
```

직전 값을 `useState`가 아니라 `useRef`에 두는 이유: 상태로 두면 값이 바뀔 때마다 리렌더가 일어나고,
그게 다시 effect를 건드릴 수 있다. ref는 "렌더와 무관하게 기억만 하는 상자"다.

전이 감지(`!p.breaker.open && data.breaker.open`)가 이벤트 로그의 핵심이다.
현재 상태만 보면 "열림"이 계속 찍힌다. 닫힘 → 열림으로 바뀐 그 순간만 한 줄 남긴다.

정리 함수(`return () => ...`)를 빠뜨리면 대시보드를 떠나도 1초마다 fetch가 계속 돈다.

상황: 브라우저에서 동시에 20발을 쏘는 중
파일: web/src/api.ts

```js
// 동시 count개의 질문을 쏴서(트래픽 폭주 흉내) 상태별로 집계한다.
export async function burst(count, question = "환불은 며칠 걸려?") {
  const one = async () => {
    try {
      const res = await fetch(`${BASE}/chat`, { method: "POST", ... });
      if (res.status === 429) { await res.text().catch(() => {}); return "rejected"; }
      const text = await res.text().catch(() => "");
      // SSE 본문을 통째로 받아 내용으로 판별한다 (스트림을 파싱할 필요가 없어서)
      if (text.includes("답변 생성이 어려워")) return "degraded";
      if (text.includes("관련 내용을 찾지 못했")) return "refused";
      return "ok";
    } catch { return "error"; }
  };
  const results = await Promise.all(Array.from({ length: count }, one));   // 20개를 동시에
  const tally = { ok: 0, rejected: 0, degraded: 0, refused: 0, error: 0 };
  for (const r of results) tally[r]++;
  return tally;
}
```

`Promise.all`이 "동시"를 만든다. `for` 안에서 `await`하면 하나 끝나고 다음이라 폭주가 안 된다.
`Array.from({length: 20}, one)`은 `one()`을 20번 불러 Promise 20개를 만든다 — 이 시점에 이미 다 출발했다.

429일 때 `res.text()`를 읽고 버리는 이유: 본문을 안 읽으면 연결이 정리되지 않고 남을 수 있다.

상황: 각 방어 레이어의 현재 상태를 카드로 그리는 중
파일: web/src/components/Dashboard.tsx

```jsx
        <Layer
          name="Admission Control"
          sub="동시 처리 상한 + 대기 데드라인"
          active={(ad?.queued ?? 0) > 0}
          stat={
            `처리중 ${ad?.inFlight ?? 0}/${ad?.maxInFlight ?? "-"} · 대기 ${ad?.queued ?? 0}` +
            // 큐가 꽉 차 즉시 튕긴 것과, 기다리다 데드라인에 포기한 것을 구분해 보여준다.
            // 둘은 원인이 다르다 — 전자는 지속 과부하, 후자는 처리가 느려졌다는 신호.
            ((ad?.rejected ?? 0) > 0 ? ` · 거절 ${ad.rejected}` : "") +
            ((ad?.timedOut ?? 0) > 0 ? ` · 대기포기 ${ad.timedOut}` : "")
          }
        />
```

`rejected`와 `timedOut`을 합치지 않고 나눠 보여주는 게 이 대시보드의 의도다.
숫자 하나로 합치면 "과부하다"까지만 알고, 뭘 고쳐야 할지는 모른다.
거절이 많으면 용량을 늘려야 하고, 대기포기가 많으면 처리 자체가 느려진 것이다.

`?.`와 `??`가 계속 나오는 이유: 첫 렌더에서 `m`은 아직 null이다(fetch 전).
`m.admission.inFlight`로 쓰면 그 순간 화면이 통째로 죽는다.

---

# 7. 왜 그렇게 하나

## 왜 문자열 → 배열 → 문자열로 한 바퀴 도나

```
"환불 금액은 영업일 기준 3~5일 이내에 입금됩니다"      원문 (문자열)

   ↓ split(/\s+/)   겹치게 자르려면 "몇 번째 단어"를 세야 하는데
                    문자열 통짜로는 못 셈. 배열로 만들면 번호가 붙음.

["환불","금액은","영업일","기준","3~5일","이내에","입금됩니다"]
   0      1        2       3      4       5        6

   ↓ slice(start, start+size)   번호로 "0번부터 200개" 정확히 떼어냄.
                                다음 조각은 160번부터. 이 계산이 곧 겹침.

["환불","금액은", ... 200개]                        잘라낸 배열

   ↓ join(" ")   자르기 끝났으니 다시 사람이 읽는 글로.
                 배열 상태로는 임베딩도 DB 저장도 안 됨.

"환불 금액은 영업일 기준 3~5일 이내에 입금됩니다"      조각 1개 완성
```

한 줄: 자르려고 배열로 갔다가, 자르고 다시 글로 돌아온다. 배열은 잠깐 쓰는 작업대.

## 왜 겹치게 자르나

겹치지 않고 자르면 문장 한가운데가 경계에 걸린다.

```
조각1: "... 환불 금액은 영업일 기준"     ← 여기서 끊김
조각2: "3~5일 이내에 입금됩니다 ..."     ← 여기서 시작
```

"환불 며칠?"에 조각1은 "며칠"이 없고, 조각2는 "뭐가 3~5일"인지 모른다. 둘 다 반쪽.
40개 겹치면 조각2가 문장 전체를 온전히 갖는다. 겹침은 경계에 걸린 문장을 살리는 보험이다.

## 왜 방어를 한 겹이 아니라 다섯 겹으로 쌓나

각 층이 막는 문제가 다르고, 하나로는 나머지를 못 막기 때문이다.

| 층 | 막는 것 | 이게 없으면 |
|---|---|---|
| Rate Limiter | 한 명(한 IP)의 폭주 | 사용자 하나가 전체를 마비시킴 |
| Admission Control | 전체 트래픽 초과 | 다 받아서 다 같이 타임아웃 |
| Bulkhead | 한 작업 종류의 자원 독점 | 업로드가 몰려 질문이 멈춤 |
| Circuit Breaker | 죽은 외부 의존성 | 요청마다 몇 초 매달렸다 실패 |
| Degradation | 위 넷을 다 뚫고 온 실패 | 사용자가 빈손으로 돌아감 |

Rate Limiter만 있으면 "각자 조금씩 보내는 사용자 100명"을 못 막는다.
Admission Control만 있으면 한 명이 상한 8칸을 다 먹는 걸 못 막는다.

## 왜 라이브러리 대신 직접 구현했나

`express-rate-limit`, `opossum` 같은 검증된 라이브러리가 있다.
프로덕션이면 그걸 쓰는 게 맞다. 여기서 직접 짠 이유는 두 가지다.

하나, 동작을 설명할 수 있어야 한다. 붙였다는 사실보다 왜 Token Bucket인지,
왜 큐 길이만으론 부족한지를 말할 수 있어야 의미가 있다.
둘, 각각 50줄 안쪽이라 직접 짜는 비용이 학습 가치보다 작다.

바꿔야 할 시점도 정해뒀다. 서버가 여러 대가 되는 순간 C1(인메모리 버킷)과 C6(인메모리 캐시)은
인스턴스별로 따로 놀아 무의미해진다. 그때 Redis 기반으로 간다.

## 나머지 원리

| 무엇 | 왜 |
|---|---|
| 벡터를 JSON.stringify | pgvector가 `"[0.1,0.2,...]"` 문자열을 받아 vector로 해석하니까 |
| 유사도 낮으면 거절 | 엉뚱한 조각을 주면 AI가 그럴듯하게 지어내니까 (+ 토큰 절약) |
| taskType 두 종류 | 저장용과 검색용을 구분해야 매칭이 잘 맞음 |
| 트랜잭션 | 문서만 저장되고 조각은 실패한 반쪽짜리를 막으려고 |
| 근거를 답보다 먼저 전송 | 답이 흐르는 동안에도 출처가 보여야 하고, degrade 때 남는 게 그것뿐이라 |
| 스트리밍은 나중에 | 한 방에 받는 걸로 로직 검증 후 얹어야 디버깅 범위가 좁아짐 |
| 로그를 await 안 함 | 로그는 우리 것이지 사용자 것이 아님 (p99 42% 감소) |
| 자리 반납은 finally | 예외 한 번에 슬롯이 영구히 새면 서버가 조용히 멈춤 |
| 회로 상태를 openUntil(시각)로 | 닫는 타이머를 안 돌려도 됨 |
| mock provider | 부하 테스트에서 외부 LLM을 빼고 내 시스템만 측정하려고 |

## 병목은 추측하지 않고 측정했다

순서가 중요하다. 방어 레이어를 먼저 짠 게 아니라, 부하를 걸어 재고 나서 짰다.

```bash
LLM_PROVIDER=mock npm start          # 외부 LLM을 빼고 내 시스템만 남긴다
CONN=20 DUR=10 npm run loadtest      # 동시 20 연결로 10초
```

`LLM_PROVIDER=mock`이 측정의 전제다. 진짜 Gemini를 붙이면 지연의 대부분이 외부 API라
내가 고칠 수 있는 부분(HTTP·검색·캐시·풀)의 숫자가 묻힌다.
무료 티어라 부하로 두들기면 rate limit에 걸려 측정 자체가 안 되기도 한다.

결과: 병목은 LLM이 아니라 DB 커넥션 풀이었다.
그래서 순서가 캐시 → 로그 분리 → 풀 튜닝/격리로 정해졌다. 반대로 짰다면 엉뚱한 데를 고쳤을 것이다.

| 무엇을 했고 | 어떤 결과가 나왔나 |
|---|---|
| 질문 임베딩 캐시 | 반복 질문 1197ms → 0.05ms |
| 로그 쓰기 백그라운드 분리 | p99 2794 → 1606ms (-42%) |
| LLM에 circuit breaker | 5회 실패 후 회로 열림, 지연 500 → 190ms |

---

# 8. 헷갈리는 것

## 변수 — 뭐가 고정이고 뭐가 움직이나

chunkText의 변수 4개 중 3개는 고정, 1개만 움직인다.

| 이름 | 값 | 변하나 | 뜻 |
|---|---|---|---|
| size | 200 | 안 변함 | 조각 하나의 길이 |
| overlap | 40 | 안 변함 | 겹칠 길이 |
| step | 160 | 안 변함 | 다음 시작점 간격 (size - overlap) |
| start | 0→160→320 | 이것만 움직임 | 지금 조각을 어디서부터 뜨나 |

작은 숫자로 추적. 단어 10개, size=5, overlap=2 → step=3.

```
words = [A B C D E F G H I J]   (10개)

start=0 → slice(0,5)  = A B C D E     0+5=5,  10 미만 → 계속
start=3 → slice(3,8)  = D E F G H     3+5=8,  10 미만 → 계속
start=6 → slice(6,11) = G H I J       6+5=11, 10 이상 → break
```

조각1 끝 D E, 조각2 앞 D E. 딱 2개 겹침 = overlap 2.

## 변수 — admission의 자리 계산

`inFlight`와 `waiters.length` 둘 다 움직인다. 상한 2, 큐 2로 추적한다.

| 사건 | inFlight | waiters | 결과 |
|---|---|---|---|
| 시작 | 0 | 0 | — |
| acquire ①② | 2 | 0 | 둘 다 즉시 true |
| acquire ③ | 2 | 1 | 큐에 대기 (아직 미확정) |
| acquire ④ | 2 | 2 | 큐에 대기 |
| acquire ⑤ | 2 | 2 | 큐 꽉 참 → 즉시 false, rejected++ |
| release() | 2 | 1 | ③에게 바통 전달. inFlight는 그대로 |
| ③ 2초 지남 | 2 | 1 | (이미 통과했으므로 타이머는 clearTimeout됨) |
| ④ 2초 지남 | 2 | 0 | 데드라인 초과 → false, timedOut++ |
| release() ×2 | 0 | 0 | 대기자 없으니 자리를 비운다 |

핵심: release가 대기자에게 넘길 때는 inFlight가 안 줄어든다. 자리 개수는 늘 상한 이하로 유지된다.

## 메서드 — 정의 말고 "넣으면 → 나오면"

| 메서드 | 넣으면 | 나오면 | 예시 |
|---|---|---|---|
| split(구분자) | 문자열 | 배열 | `"a b".split(" ")` → `["a","b"]` |
| join(붙일것) | 배열 | 문자열 | `["a","b"].join(" ")` → `"a b"` |
| slice(시작,끝) | 배열 | 잘라낸 새 배열 | `[1,2,3,4].slice(1,3)` → `[2,3]` |
| splice(위치,개수) | 배열 | 원본에서 제거 | `arr.splice(1,1)` → 원본이 짧아짐 |
| filter(조건) | 배열 | 더 짧은 배열 | `["a","",""].filter(Boolean)` → `["a"]` |
| map(바꿀식) | 배열 | 같은 길이 배열 | `[1,2].map(x=>x*10)` → `[10,20]` |
| shift() | 배열 | 맨 앞 항목 (원본 짧아짐) | 큐에서 꺼내기 |
| pop() | 배열 | 맨 끝 항목 (원본 짧아짐) | SSE 미완성 조각 되돌리기 |

slice와 splice가 제일 헷갈린다. slice는 복사(원본 그대로), splice는 수술(원본이 바뀜).
admission.ts에서 타임아웃된 대기자를 큐에서 뺄 때 splice를 쓰는 건 원본을 바꿔야 하기 때문이다.

map은 3개 넣으면 3개 나온다는 게 핵심. 내용만 바뀐다.

```js
result.embeddings.map((e) => e.values)
// 3개 배열 → 3개 배열. 각 항목이 {values:[...]} 에서 [...] 로만 바뀜 (껍데기 벗기기)
```

## API 응답 — 봉투에 담겨 온다

```js
await ai.models.embedContent({ contents: ["조각1","조각2","조각3"] });   // 3개 보냄

result = {
  embeddings: [                    // 3개 보냈으니 3개가 옴 → 복수형 s
    { values: [0.1, -0.2, ...] },  // 조각1의 숫자 768개
    { values: [0.5, 0.3, ...] },   // 조각2
    { values: [-0.1, 0.9, ...] },  // 조각3
  ]
}
```

`result.embeddings` = 봉투 열어 목록 꺼내기. 여러 개 보냈으니 복수형.
처음 쓰는 API는 외우지 말고 `console.log(JSON.stringify(result, null, 2))` 한 번 찍어본다.

우리가 만드는 봉투도 같은 구조다. `/api/metrics` 응답:

```js
{
  cache:     { hits, misses, hitRate, keys },
  readPool:  { total, idle, waiting },      // 풀이 둘이라 키도 둘
  writePool: { total, idle, waiting },
  rateLimit: { buckets, rejected, capacity, refillPerSec },
  admission: { inFlight, queued, maxInFlight, maxQueue, timedOut, rejected },
  breaker:   { open, consecutiveFailures, reopensInMs },
  faults:    { llmFail },
}
```

각 모듈의 `xxxStats()`가 자기 칸을 채운다. 화면(D4)은 이 모양을 그대로 읽는다.

## SSE 이벤트 5종 — 언제 무엇이 오나

| type | 언제 | 화면이 하는 일 |
|---|---|---|
| sources | 검색 통과 직후, 생성 전 | 출처 카드를 그린다 |
| delta | 생성 중 여러 번 | content에 이어붙인다 |
| refusal | 유사도 미달 | 거절 문구로 바꾸고 끝 |
| done | 정상 종료 | 토큰 수를 표시한다 |
| error | 우리 쪽(DB·검색) 오류 | 에러 스타일로 표시 |

degrade는 새 타입을 만들지 않고 delta + done을 쓴다. 화면 입장에서 "짧게 끝난 답변"이다.
거절(refusal)과 degrade는 완전히 다른 것이다 — 전자는 문서에 없음, 후자는 LLM을 못 씀.

---

# 9. 검색해서 쓸 것 (외우지 말 것)

| 항목 | 이유 |
|---|---|
| Express 뼈대 (app.use, app.listen, 에러 핸들러) | 프로젝트마다 똑같음 |
| multer 업로드 설정 | 옵션만 검색해서 붙임 |
| `new pg.Pool({...})` 옵션 이름 | 한 번 쓰고 안 건드림 |
| create table / create extension | SQL 레퍼런스 |
| hnsw 인덱스 문법 | pgvector 문서에 그대로 있음 |
| begin / commit / rollback 구문 | 개념만 알고 구문은 검색 |
| SSE 헤더 3줄 | 규약이라 외울 게 아님 |
| CORS, dotenv, vite proxy 설정 | 각각 한 줄 |
| React useState / useEffect / useRef 문법 | 리액트 기본 |
| `node:test` / `assert` 문법 | 표준 라이브러리 문서 |
| autocannon 옵션 | 부하 도구는 언제든 바뀔 수 있음 |

외울 것은 이쪽이다:

| 항목 | 이유 |
|---|---|
| step = size - overlap, break 조건 | 이 프로젝트 고유 로직 |
| 거절 게이트의 위치(검색 후, 생성 전) | 순서가 곧 설계 |
| 임계값을 재서 정하는 방법 | 값이 아니라 방법이 자산 |
| Token Bucket의 lazy refill | 타이머 없이 계산으로 푸는 요령 |
| 큐 길이 + 데드라인 둘 다 필요한 이유 | 면접에서 가장 많이 묻는 지점 |
| release가 inFlight를 안 줄이는 이유 | 틀리기 쉽고 티가 안 남 |
| 회로를 openUntil(시각)로 잡는 이유 | 상태 하나를 줄이는 설계 |
| SSE 버퍼의 parts.pop() | 스트리밍 파싱의 핵심 |
| 로그를 await 하지 않는 것 + .catch() | 성능과 안정성이 맞물림 |

---

# 10. 자가 점검

백지에 이것만 되면 칠 수 있다. 막히는 번호가 있으면 그 칸으로 돌아간다.

RAG 코어 (흐름 A·B)
1. 21칸을 A/B/C/D로 나눠 말할 수 있나
2. `step = size - overlap`과 break 조건을 안 보고 쓸 수 있나 (→ A2)
3. 왜 문자열을 배열로 바꿨다가 다시 문자열로 되돌리나 (→ 7장)
4. `<=>`가 거리인지 유사도인지, 유사도로 바꾸려면 어떻게 하는지 (→ B3)
5. 거절 게이트가 어디 있고, 걸리면 LLM을 부르는지 안 부르는지 (→ B4)
6. 임계값 0.62를 어떻게 정했고, 문서가 바뀌면 어떻게 다시 정하는지 (→ B4)
7. 벡터를 DB에 넣을 때 왜 JSON.stringify 하는지 (→ A4)
8. taskType이 두 종류인 이유 (→ B2)
9. 트랜잭션이 없으면 어떤 잘못된 상태가 남는지 (→ A4)
10. `data: {...}\n\n` 형식과 `parts.pop()` 이유를 설명할 수 있나 (→ B7)

방어 레이어 (흐름 C)
11. 요청이 거치는 다섯 층의 순서와 각 층이 막는 문제를 말할 수 있나 (→ 5장 앞머리)
12. 왜 고정 윈도우가 아니라 Token Bucket인가 (→ C1)
13. 타이머 없이 토큰을 채우는 방법(lazy refill)을 설명할 수 있나 (→ C1)
14. 큐 길이 상한만으로 왜 부족한가 (→ C2)
15. release가 대기자에게 자리를 넘길 때 inFlight를 왜 안 줄이나 (→ C2)
16. `settled` 플래그가 없으면 무슨 일이 나나 (→ C2)
17. 읽기/쓰기 풀을 나눈 기준이 뭔가. 로그 쓰기는 어느 쪽인가 (→ C3)
18. 왜 "누적"이 아니라 "연속" 실패로 회로를 여나 (→ C4)
19. half-open 상태를 안 만들고도 같은 효과를 낸 방법 (→ C4)
20. degrade가 새 이벤트 타입 대신 delta를 쓰는 이유 (→ C5)
21. 거절(refusal)과 degrade의 차이를 사용자 관점에서 말할 수 있나 (→ C5)
22. 캐시 set 실패를 왜 삼키나 (→ C6)
23. rate limit은 `req.ip`, 관리자 인증은 `req.socket.remoteAddress`인 이유 (→ C8)

측정과 화면 (흐름 D)
24. 부하 테스트에 왜 `LLM_PROVIDER=mock`이 필요한가 (→ 7장)
25. 병목이 뭐로 나왔고, 그게 작업 순서를 어떻게 정했나 (→ 7장)
26. `setMessages(prev => ...)`로 함수를 넘기는 이유 (→ D2)
27. 빈 assistant 메시지를 미리 넣어두는 이유 (→ D2)
28. 대시보드가 직전 값을 useState 대신 useRef에 두는 이유 (→ D4)
29. `rejected`와 `timedOut`을 나눠 보여주는 이유 (→ D4)

전체
30. 이 프로젝트를 다시 만든다면 어느 순서로 만들 것인가 (→ 2장)
