# DocChat 공부 노트

이 노트만 보고 프로젝트를 백지에서 다시 칠 수 있게 만든 문서.
순서: 기획 → 지도 → 만드는 순서 → 흐름별 코드(주석) → 원리 → 헷갈리는 것 → 검색할 것 → 자가 점검.

> 파일 경로는 TypeScript 전환에 맞춰 갱신했지만, 아래 코드 조각은 아직 전환 전의
> JavaScript 형태다(타입 표기 없음). 흐름과 판단을 익히는 데는 그대로 쓸 수 있고,
> 실제 타입이 붙은 코드는 소스 파일을 보면 된다.
> 실시간 채팅 부분은 [STUDY-REALTIME.md](STUDY-REALTIME.md)에 따로 있다.

---

# 0. 기획 — 코드 치기 전에 정하는 순서

바로 코드부터 치지 않는다. 종이 한 장에 아래 8개를 먼저 적는다.

무슨 문제를 푸나
  AI가 우리 문서를 몰라서 아무 말이나 지어내는 문제. (한 문장이 모든 선택의 기준)

사용 시나리오
  1) 문서 올린다 2) 질문한다 3) 근거 문서와 함께 답이 뜬다 4) 없는 질문이면 없다고 한다.
  여기서 필요한 API가 나온다: 올리기(업로드), 묻기(채팅), 근거(응답에 출처 포함).

안 할 것 (스코프)
  멀티턴 대화, PDF, 로그인, 문서 공유. 핵심(RAG 정확도)에 집중하려고 뺀다.

데이터 흐름 두 줄 (나침반)
  넣기: 문서 → 조각내기 → 숫자로 → 저장
  묻기: 질문 → 숫자로 → 비슷한 조각 찾기 → 그걸 근거로 답 생성

뭘 저장할지 (화면에서 거꾸로)
  목록 보여주려면 파일명(documents), 검색하려면 조각+벡터(chunks),
  임계값 조정하려면 질문 기록(query_logs). 표 3개.

기술 선택 (제약에서 출발)
  제약: 무료여야 함, 혼자 만듦, 짧게 끝냄.
  Gemini 무료 티어(카드 불필요) · pgvector(Postgres 하나로) · React(익숙) · SSE(단방향이라 충분).

만드는 순서 (줄기 먼저)
  줄기: 청킹 → 임베딩 → 저장 → 검색 → 생성 (터미널에서 되면 완성)
  가지: 거절 → 스트리밍 → 화면 → 로깅·재시도

완료 기준
  올리면 조각 수가 뜬다 / "환불 며칠?" 근거와 함께 답한다 / "프랑스 수도?" 거절한다 / 답이 흐른다.

---

# 1. 전체 지도 (11칸)

| 칸 | 하는 일 | 파일 |
|---|---|---|
| A1 | 파일 받아 글자 꺼내기 | server/routes/documents.ts |
| A2 | 겹치게 조각내기 | server/chunk.ts |
| A3 | 조각을 숫자(벡터)로 | server/gemini.ts |
| A4 | DB에 저장 | server/routes/documents.ts |
| B1 | 질문 받고 스트리밍 준비 | server/routes/chat.ts |
| B2 | 질문을 숫자로 | server/gemini.ts |
| B3 | 가까운 조각 5개 찾기 | server/routes/chat.ts |
| B4 | 멀면 거절 | server/routes/chat.ts |
| B5 | 프롬프트 조립 | server/gemini.ts |
| B6 | 답을 조각조각 전송 | server/routes/chat.ts |
| B7 | 화면에서 받아 붙이기 | web/src/api.ts |

A는 문서 넣기 4칸, B는 질문하기 7칸. 이 둘을 이어주는 게 server/index.ts(서버 뼈대).

---

# 2. 만드는 순서

핵심 원칙: 처음부터 서버·라우트를 만들지 말고, 작은 스크립트로 하나씩 켜보며 쌓다가
마지막에 서버로 옮긴다. 한 조각 만들 때마다 반드시 켜보고 다음으로 간다.

| 순서 | 만드는 것 | 왜 이때 | 켜보기(성공 신호) |
|---|---|---|---|
| 1 | chunk.ts | 의존성 0, 순수함수 | 450단어 → 조각 3개? |
| 2 | gemini.ts (임베딩만) | 첫 외부 연결 확인 | 벡터 길이 768? |
| 3 | schema.sql + db.ts | 담을 그릇 | select 1+1 동작? |
| 4 | ingest.ts (저장 스크립트) | 셋을 처음 합침 | 저장 완료 로그? |
| 5 | search.ts (검색 스크립트) | 줄기의 심장 | 관련 조각이 1등? |
| 6 | ask.ts (생성, 한 방에) | 줄기 완성 | 터미널에 답 출력? |
| 7 | index.ts (서버로 옮기기) | 스크립트를 라우트로 | curl로 답 받기? |
| 8+ | 거절 → 스트리밍 → 화면 → 로깅·재시도 | 가지, 우선순위 순 | 하나씩 켜보며 |

6단계까지가 줄기다. 여기까지면 화면이 없어도 RAG는 완성.
스트리밍은 반드시 나중에. 한 방에 받는 걸로 로직을 먼저 검증하고 그 위에 얹는다.

준비물:

```bash
mkdir -p docchat/server && cd docchat/server
npm init -y
npm install express cors pg dotenv multer @google/genai
# package.json에  "type": "module"  추가 (import 문법용)
# .env 에  GEMINI_API_KEY=...  DATABASE_URL=postgres://postgres:postgres@localhost:5432/docchat
```

---

# 3. 흐름 A — 문서 넣기

## A0. 서버 뼈대 (한 번 만들고 안 건드림)

상황: 라우트들을 연결하는 입구. 보일러플레이트라 검색해서 붙여도 됨
파일: server/index.ts

```js
import "dotenv/config";                 // 맨 위. 환경변수를 먼저 로드해야 아래가 읽음
import express from "express";
import cors from "cors";
import documentsRouter from "./routes/documents.ts";
import chatRouter from "./routes/chat.ts";

const app = express();
app.use(cors());                        // 브라우저(다른 포트)에서 부를 수 있게
app.use(express.json());                // 요청 본문의 JSON을 req.body로 파싱

app.use("/api/documents", documentsRouter);  // 문서 관련 요청을 이 라우터로
app.use("/api/chat", chatRouter);            // 채팅 요청을 이 라우터로

app.listen(4000, () => console.log("http://localhost:4000"));
```

## A1. 파일 받아 글자 꺼내기

상황: 사용자가 브라우저에서 파일을 올렸고, 서버가 그걸 받는 자리
파일: server/routes/documents.ts

```js
// upload.single("file") = multer가 파일 1개를 받아서 req.file에 담아줌
router.post("/", upload.single("file"), async (req, res) => {

  if (!req.file) {                                     // 파일이 안 왔으면
    return res.status(400).json({ error: "파일이 없습니다." });   // 400 = 잘못된 요청
  }

  // multer는 파일명을 latin1로 해석해서 한글 이름이 깨짐 → utf8로 되돌림
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");

  // req.file.buffer = 파일 내용이 담긴 이진 데이터
  // toString("utf8") = 이진 데이터를 사람이 읽는 글자로 변환
  const text = req.file.buffer.toString("utf8");
```

데이터 모양: 이진데이터 → `"# 환불 정책\n\n환불은 7일 이내..."` (문자열)

## A2. 겹치게 조각내기

상황: text에 문서 전체 글이 통째로 있음. 검색하려면 잘라야 함
파일: server/chunk.ts

```js
export function chunkText(text, size = 200, overlap = 40) {

  // split(/\s+/) = 공백(스페이스·줄바꿈) 기준으로 단어 배열로 쪼갬
  //   "환불 정책 안내" → ["환불", "정책", "안내"]
  // filter(Boolean) = 쪼개다 생긴 빈 칸("")을 버림 (빈 문자열은 거짓 취급이라 걸러짐)
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) return [];   // 빈 문서면 빈 배열

  const chunks = [];              // 완성된 조각을 담을 빈 상자
  const step = size - overlap;    // 다음 조각을 얼마나 뒤에서 시작할지 (200-40=160)

  // start를 0 → 160 → 320 ... step씩 밀면서 반복
  for (let start = 0; start < words.length; start += step) {

    // slice(start, start+200) = start부터 200개 단어를 떼어냄
    // join(" ")                = 떼어낸 단어들을 다시 공백으로 이어 문장으로
    chunks.push(words.slice(start, start + size).join(" "));

    // 이번 조각이 문서 끝까지 덮었으면 더 돌 필요 없음
    if (start + size >= words.length) break;
  }

  return chunks;   // ["조각1 글...", "조각2 글...", ...]
}
```

데이터 모양: "통글" → ["단어","단어",...] → ["조각1 글", "조각2 글", ...]

## A3. 조각을 숫자(벡터)로

상황: 조각 배열이 생김. 뜻으로 검색하려면 각 조각을 숫자로 바꿔야 함
파일: server/gemini.ts

```js
export async function embedTexts(texts, taskType = "RETRIEVAL_DOCUMENT") {

  // embedContent = "이 글들을 숫자로 바꿔줘"라고 Gemini에 요청
  const result = await ai.models.embedContent({
    model: "gemini-embedding-001",     // 글→숫자 전용 모델
    contents: texts,                   // 조각들(배열). 여러 개를 한 번에 보냄
    config: {
      taskType,                        // 저장: RETRIEVAL_DOCUMENT / 질문: RETRIEVAL_QUERY
      outputDimensionality: 768,       // 숫자 개수. schema.sql의 vector(768)과 같아야 함
    },
  });

  // 응답 모양: { embeddings: [ {values:[0.1,...]}, {values:[...]} ] }
  // map으로 values만 뽑음 → [[0.1,...], [...]]
  return result.embeddings.map((e) => e.values);
}
```

데이터 모양: ["조각1","조각2"] → [{values:[...]},{values:[...]}] → [[0.1,...],[0.5,...]]

무료 티어는 분당 요청 제한이 있어 조각이 많으면 10개씩 나눠 보낸다:

```js
async function chunkAndEmbed(text) {
  const chunks = chunkText(text);
  const embeddings = [];

  // 0, 10, 20... 씩 건너뛰며 10개 묶음으로 처리
  for (let i = 0; i < chunks.length; i += 10) {
    // slice(i, i+10) = 10개만 잘라 보냄
    // ...(스프레드) = 돌려받은 배열을 낱개로 풀어 넣음 (안 그러면 배열이 겹쳐짐)
    embeddings.push(...(await embedTexts(chunks.slice(i, i + 10))));
  }
  return { chunks, embeddings };
}
```

## A4. DB에 저장

상황: 조각 배열과 벡터 배열이 손에 있음. 짝지어 저장
파일: server/routes/documents.ts

```js
// pool.connect() = 연결 하나를 빌림 (트랜잭션은 같은 연결에서 이어져야 해서)
const client = await pool.connect();

try {
  await client.query("begin");        // 트랜잭션 시작 = "지금부터 묶음"

  // 1) 문서를 먼저 저장하고 새로 생긴 id를 돌려받음
  const docResult = await client.query(
    "insert into documents (filename, content) values ($1, $2) returning id",
    // $1, $2 = 값 자리표시자. 값을 문자열에 직접 붙이면 SQL 인젝션 위험
    // returning id = 방금 저장된 줄의 id를 돌려달라
    [filename, text]
  );
  const docId = docResult.rows[0].id;   // rows는 항상 배열이라 [0]으로 첫 줄

  // 2) 조각을 하나씩 저장 (i = 몇 번째 조각)
  for (let i = 0; i < chunks.length; i++) {
    await client.query(
      `insert into chunks (document_id, chunk_index, content, embedding)
       values ($1, $2, $3, $4)`,
      [
        docId,                          // 어느 문서의 조각인지 (연결고리)
        i,                              // 순서
        chunks[i],                      // 조각 글
        JSON.stringify(embeddings[i]),  // 벡터는 문자열로 바꿔야 pgvector가 받음
      ]
    );
  }

  await client.query("commit");        // 여기까지 다 됐으면 확정
} catch (e) {
  await client.query("rollback");      // 중간에 하나라도 실패하면 통째로 취소
  throw e;
} finally {
  client.release();                    // 빌린 연결은 반드시 반납
}
```

데이터 모양: [0.1, -0.2, ...] → "[0.1,-0.2,...]" (DB에 넣는 형태)

---

# 4. 흐름 B — 질문하기

## B1. 질문 받고 스트리밍 준비

상황: 사용자가 채팅창에 질문을 쳐서 보냄
파일: server/routes/chat.ts

```js
router.post("/", async (req, res) => {

  // req.body.question = 브라우저가 보낸 JSON 안의 question 값
  // trim() = 앞뒤 공백 제거
  const question = (req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "질문을 입력해주세요." });

  // 이 응답은 한 번에 안 끝나고 조금씩 흘려보낼 거라고 브라우저에 선언
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 데이터 보낼 때 쓸 도구
  // res.write = 연결을 끊지 않고 조각을 계속 써 보냄
  // "data: {...}\n\n" = SSE 규격. 빈 줄(\n\n)이 "한 덩어리 끝" 표시
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const started = Date.now();   // 응답 시간 재려고 시작 시각 기록
```

## B2. 질문을 숫자로

상황: 질문을 조각들과 비교하려면 같은 형식(숫자)이어야 함
파일: server/gemini.ts

```js
export async function embedQuery(text) {

  // A3의 embedTexts를 재사용. 다른 건 taskType 하나뿐
  //   저장은 RETRIEVAL_DOCUMENT, 찾을 땐 RETRIEVAL_QUERY
  // [vector] = 결과 배열의 첫 번째를 바로 꺼냄 (질문은 하나니까)
  const [vector] = await embedTexts([text], "RETRIEVAL_QUERY");

  return vector;   // [0.03, -0.11, ...] 숫자 768개
}
```

데이터 모양: "환불 며칠?" → [0.03, -0.11, ...] (숫자 768개)

## B3. 가까운 조각 찾기

상황: 질문 벡터가 생김. 저장된 조각 중 뜻이 가까운 걸 골라옴
파일: server/routes/chat.ts

```sql
select
  c.content,                                    -- 조각 글
  d.filename,                                   -- 어느 파일에서 온 조각인지
  1 - (c.embedding <=> $1::vector) as similarity
  -- <=>        : 두 벡터 사이 거리를 재는 pgvector 기호 (작을수록 비슷)
  -- $1::vector : 넘긴 문자열을 vector 타입으로 취급하라
  -- 1 - 거리   : 사람이 읽기 쉽게 유사도로 뒤집음 (클수록 비슷)
from chunks c
join documents d on d.id = c.document_id        -- 조각에 파일명을 붙여옴
order by c.embedding <=> $1::vector             -- 가까운 순으로 줄 세움
limit $2                                        -- 그중 위에서 5개만
```

```js
const { rows } = await pool.query(위_SQL, [
  JSON.stringify(queryEmbedding),   // 벡터는 여기서도 문자열로
  5,                                 // TOP_K = 5개
]);
```

데이터 모양: rows = [{content:"...", filename:"환불.md", similarity:0.74}, ...] 5개

## B4. 멀면 거절

상황: 검색 결과가 손에 있음. 쓸만한지 판단하는 갈림길
파일: server/routes/chat.ts

```js
// rows[0] = 가장 비슷한 조각
// ?.      = 값이 없어도 에러 안 나게 하는 안전장치
// ?? 0    = 값이 없으면 0으로 취급
const topSimilarity = rows[0]?.similarity ?? 0;

// 결과가 없거나 제일 비슷한 것도 0.62 미만이면
if (rows.length === 0 || topSimilarity < THRESHOLD) {

  send({ type: "refusal", message: "문서에서 관련 내용을 찾지 못했어요" });

  // 거절한 경우에도 로그를 남김 → 나중에 임계값 조정 근거
  await pool.query(
    `insert into query_logs (question, refused, top_similarity, latency_ms)
     values ($1, true, $2, $3)`,
    [question, topSimilarity, Date.now() - started]
  );

  res.end();   // 여기서 끝 — AI를 부르지도 않음 (헛소리 방지 + 비용 절약)
  return;
}
```

임계값 0.62는 감이 아니라 실측: 관련 질문 0.66~0.74 vs 무관 0.52~0.59 → 그 사이.

## B5. 프롬프트 조립

상황: 쓸만한 조각 5개 확보. 이걸 근거로 답하라고 시킴
파일: server/gemini.ts

```js
// 답변보다 근거를 먼저 보냄 → 스트리밍 중에도 출처가 화면에 떠 있음
send({
  type: "sources",
  sources: rows.map((r, i) => ({
    index: i + 1,                                     // i는 0부터라 +1
    filename: r.filename,
    snippet: r.content.slice(0, 100),                 // 미리보기 100자
    similarity: Math.round(r.similarity * 100) / 100, // 0.7412 → 0.74
  })),
});
```

```js
const contextBlock = contexts
  // 조각마다 번호를 붙임. i는 0부터라 +1 → 답변의 [1] 인용과 짝이 맞음
  .map((c, i) => `[${i + 1}] (출처: ${c.filename})\n${c.content}`)
  .join("\n\n");   // 조각들 사이를 빈 줄로 띄워 구분

const prompt = `당신은 사용자가 업로드한 문서를 근거로 답하는 어시스턴트입니다.

규칙:
- 아래 발췌 내용만 근거로 답합니다. 발췌에 없으면 문서에 없다고 답하세요.
- 근거로 사용한 발췌 번호를 [1], [2] 형태로 표시하세요.
- 굵게(**), 제목(#) 같은 마크다운 서식은 쓰지 마세요.

발췌:
${contextBlock}

질문: ${question}`;
```

## B6. 답을 조각조각 전송

상황: AI가 답을 만들기 시작. 다 기다리지 않고 오는 대로 전송
파일: server/routes/chat.ts

```js
const stream = await streamAnswer(question, rows);
let answer = "";      // 완성본을 모아둘 곳 (로그 저장용)
let usage = null;     // 토큰 사용량

// for await = 조각이 도착할 때마다 한 바퀴 (일반 for와 달리 다음 조각을 기다려줌)
for await (const chunk of stream) {
  if (chunk.text) {                              // 글자가 든 조각이면
    answer += chunk.text;                        // 모아두고
    send({ type: "delta", text: chunk.text });   // 브라우저로 즉시 전송
  }
  if (chunk.usageMetadata) usage = chunk.usageMetadata;   // 토큰은 보통 마지막에 옴
}

send({ type: "done", usage: {
  promptTokens: usage?.promptTokenCount ?? null,
  outputTokens: usage?.candidatesTokenCount ?? null,
}});

// 유사도 / 토큰 / 응답시간을 로그로 남김 (토큰이 곧 비용이라 추적)
await pool.query(
  `insert into query_logs
     (question, answer, refused, top_similarity, prompt_tokens, output_tokens, latency_ms)
   values ($1, $2, false, $3, $4, $5, $6)`,
  [question, answer, topSimilarity, promptTokens, outputTokens, Date.now() - started]
);
res.end();
```

## B7. 화면에서 받아 붙이기

상황: 서버가 조각을 계속 보내는 중. 브라우저가 받아 화면에 이어붙임
파일: web/src/api.ts

```js
// EventSource(브라우저 기본 SSE 도구)는 GET만 됨.
// 질문을 POST 본문으로 보내야 해서 fetch로 직접 파싱한다.
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question }),
});

const reader = res.body.getReader();   // 응답을 조금씩 읽는 도구
const decoder = new TextDecoder();     // 이진 데이터를 글자로 바꾸는 도구
let buffer = "";                        // 아직 완성 안 된 글자를 쌓아두는 곳

while (true) {
  const { done, value } = await reader.read();   // 다음 조각이 올 때까지 기다림
  if (done) break;                               // 더 안 오면 종료

  // value(이진) → 글자로 바꿔 buffer 뒤에 붙임
  // { stream: true } = 아직 더 올 거니 중간에 잘려도 안 깨지게
  buffer += decoder.decode(value, { stream: true });

  const parts = buffer.split("\n\n");   // 빈 줄로 덩어리 나누기

  // 마지막 덩어리는 반쪽일 수 있으니 buffer에 도로 넣어둠
  //   네트워크 데이터는 이벤트 경계에서 딱 끊겨 오지 않기 때문
  //   → 다음 데이터와 합쳐져 완성되면 그때 처리
  buffer = parts.pop();

  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5));   // "data:" 5글자 떼고 JSON 해석
    handlers[event.type]?.(event);             // 타입(sources/delta/refusal/done)별 처리
  }
}
```

---

# 5. 왜 그렇게 하나

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

40개 겹치면 조각2가 "환불 금액은 ... 3~5일 이내에 입금됩니다"를 온전히 갖는다.
겹침은 경계에 걸린 문장을 살리는 보험이다.

## 나머지 원리

| 무엇 | 왜 |
|---|---|
| 벡터를 JSON.stringify | pgvector가 "[0.1,0.2,...]" 문자열을 받아 vector로 해석하니까 |
| 유사도 낮으면 거절 | 엉뚱한 조각을 주면 AI가 그럴듯하게 지어내니까 (+ 토큰 절약) |
| taskType 두 종류 | 저장용과 검색용을 구분해야 매칭이 잘 맞음 |
| 트랜잭션 | 문서만 저장되고 조각은 실패한 반쪽짜리를 막으려고 |
| 근거를 답보다 먼저 전송 | 답이 흐르는 동안에도 출처가 보여야 신뢰가 감 |
| 스트리밍은 나중에 | 한 방에 받는 걸로 로직 검증 후 얹어야 디버깅이 쉬움 |

---

# 6. 헷갈리는 것 3종

## 변수 — 뭐가 고정이고 뭐가 움직이나

chunkText의 변수 4개 중 3개는 고정, 1개만 움직인다.

| 이름 | 값 | 변하나 | 뜻 |
|---|---|---|---|
| size | 200 | 안 변함 | 조각 하나의 길이 |
| overlap | 40 | 안 변함 | 겹칠 길이 |
| step | 160 | 안 변함 | 다음 시작점 간격 (size-overlap) |
| start | 0→160→320 | 이것만 움직임 | 지금 조각을 어디서부터 뜨나 |

작은 숫자로 추적. 단어 10개, size=5, overlap=2 → step=3.

```
words = [A B C D E F G H I J]   (10개)

start=0 → slice(0,5)  = A B C D E     0+5=5,  10 미만 → 계속
start=3 → slice(3,8)  = D E F G H     3+5=8,  10 미만 → 계속
start=6 → slice(6,11) = G H I J       6+5=11, 10 이상 → break
```

조각1 끝 D E, 조각2 앞 D E. 딱 2개 겹침 = overlap 2.

## 메서드 — 정의 말고 "넣으면 → 나오면"

| 메서드 | 넣으면 | 나오면 | 예시 |
|---|---|---|---|
| split(구분자) | 문자열 | 배열 | "a b".split(" ") → ["a","b"] |
| join(붙일것) | 배열 | 문자열 | ["a","b"].join(" ") → "a b" |
| slice(시작,끝) | 배열 | 잘라낸 배열 | [1,2,3,4].slice(1,3) → [2,3] |
| filter(조건) | 배열 | 더 짧은 배열 | ["a","",""].filter(Boolean) → ["a"] |
| map(바꿀식) | 배열 | 같은 길이 배열 | [1,2].map(x=>x*10) → [10,20] |
| push(값) | 배열에 추가 | 원본이 길어짐 | arr.push("x") |

split ↔ join은 정반대. slice는 잘라내기(짧아짐), filter는 걸러내기, map은 모양 바꾸기(길이 그대로).
map이 제일 헷갈리는데, 3개 넣으면 3개 나온다는 게 핵심. 내용만 바뀜.

```js
result.embeddings.map((e) => e.values)
// 3개 배열 → 3개 배열. 각 항목이 {values:[...]} 에서 [...] 로만 바뀜 (껍데기 벗기기)
```

## API 응답 — 봉투에 담겨 온다

```js
await ai.models.embedContent({ contents: ["조각1","조각2","조각3"] });  // 3개 보냄

result = {
  embeddings: [                    // 3개 보냈으니 3개가 옴 → 복수형 s
    { values: [0.1, -0.2, ...] },  // 조각1의 숫자 768개
    { values: [0.5, 0.3, ...] },   // 조각2
    { values: [-0.1, 0.9, ...] },  // 조각3
  ]
}
```

result.embeddings = 봉투 열어 목록 꺼내기. 여러 개 보냈으니 복수형.
처음 쓰는 API는 외우지 말고 `console.log(JSON.stringify(result, null, 2))` 한 번 찍어본다.

---

# 7. 검색해서 쓸 것 (외우지 말 것)

| 항목 | 이유 |
|---|---|
| Express 뼈대 (app.use, app.listen) | 프로젝트마다 똑같음. 복붙 |
| multer 업로드 설정 | 옵션만 검색해서 붙임 |
| new pg.Pool({...}) | 한 번 쓰고 안 건드림 |
| create table / create extension | SQL 레퍼런스 |
| hnsw 인덱스 문법 | pgvector 문서에 그대로 있음 |
| begin / commit / rollback 구문 | 개념만 알고 구문은 검색 |
| CORS, dotenv | 각각 한 줄 |
| React useState / useEffect | 리액트 기본 |
| fetch 옵션 (headers, body) | 매번 검색해도 무방 |

---

# 8. 자가 점검

백지에 이것만 되면 칠 수 있다.

1. 11칸 순서를 말할 수 있나 (A 4개, B 7개)
2. step = size - overlap 을 안 보고 쓸 수 있나
3. 왜 문자열을 배열로 바꿨다가 다시 문자열로 되돌리나
4. 왜 겹치게 자르나 (경계에 걸린 문장 예시로)
5. <=> 가 거리인지 유사도인지, 유사도로 바꾸려면 어떻게 하는지
6. 거절 게이트가 어디 있고, 걸리면 AI를 부르는지 안 부르는지
7. 임계값 0.62를 어떻게 정했는지
8. data: {...}\n\n 형식과 parts.pop() 이유를 설명할 수 있나
9. 벡터를 DB에 넣을 때 왜 JSON.stringify 하는지
10. taskType이 두 종류인 이유

막히는 번호가 있으면 그 칸으로 돌아간다.
