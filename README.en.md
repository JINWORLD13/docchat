[한국어](README.md) | [日本語](README.ja.md) | English

# DocChat

[![CI](https://github.com/JINWORLD13/docchat/actions/workflows/ci.yml/badge.svg)](https://github.com/JINWORLD13/docchat/actions/workflows/ci.yml)

[Live demo →](https://docchat-izxf.onrender.com) (Render free tier, so the server
sleeps after a while with no traffic and the first request can take up to a minute
to wake it.)

Upload a document (txt, md) and it answers using only what's in that document.
That's the RAG chatbot. I also put a real-time chat — several people talking in the
same room — on the same server. Built with TypeScript, React, Express,
PostgreSQL (pgvector), Socket.IO, and the Gemini API.
Generation can also run as a chain that puts a local LLM (Ollama) first with
Gemini as the last resort (one env line), and the same engine is exposed as a
KakaoTalk chatbot (a Kakao OpenBuilder skill) too.

One server handles two kinds of real-time — answer tokens over SSE (one-way), chat
over WebSocket (two-way, 1:N). Why I didn't split them into separate processes is
written up in [PORTFOLIO.en.md](PORTFOLIO.en.md).

> Read alongside — [PORTFOLIO.en.md](PORTFOLIO.en.md): technical choices and the
> reasons for them · [RELIABILITY.en.md](RELIABILITY.en.md): the load and failure
> design, with measurements

![An answer with its sources](docs/demo-answer.png)

(The demo UI is in Korean. The captions under each screenshot say what you're
looking at.)

The documents used and their similarity scores appear above the answer, and the
[1], [2] markers in the body link back to those sources.

![Refusing when the document doesn't cover it](docs/demo-refusal.png)

If the answer isn't in the documents, it refuses instead of making something up.
The LLM isn't even called at that point.
(The one exception is when an image is attached to the question — the evidence
moves from the documents to the image, so it doesn't refuse. See "Attaching
images to questions" below.)

![Real-time chat](docs/demo-chat.png)

People in the same room exchange messages. Room list, who's connected, join
notices, typing indicators — all of it goes through one socket. It runs on the same
server and the same port as the document Q&A (SSE).

![The dashboard while an LLM fault is injected](docs/demo-dashboard-breaker.png)

From the dashboard I can inject a traffic burst or an LLM outage directly and watch
the defense layers (Rate Limiter, Admission Control, Bulkhead, Circuit Breaker)
react in real time. The screen above is the LLM completely dead — the circuit is
open, 0 hard errors out of 20 requests, and users keep getting their sources. The
reasoning behind the design is in [RELIABILITY.en.md](RELIABILITY.en.md).

## Why I built it

Calling an LLM API once and getting an answer back is a different problem from
building an AI feature you can trust. I started this project to implement that
difference myself. Retrieval (RAG), showing the evidence, saying "I don't know"
when it doesn't know, streaming responses, token logging — everything a real
service would need, packed into a small scope.

## How it works

```
[Document upload]
file → chunk by words with overlap → embedding (Gemini 768 dims by default) → store in pgvector

[Question]
embed the question → cosine similarity search, top 5
  → top similarity < threshold : refuse (no LLM call)
    (if the question has an image attached, no refusal — the evidence is the image)
  → passes : put the excerpts in the prompt and generate → stream over SSE
    (the generator is a chain — with GENERATORS=ollama,gemini, local first, Gemini on failure)
→ show the sources and token usage, record it in query_logs

The same engine also answers as a KakaoTalk skill (/api/kakao/skill), with only the transport changed
```

## What I put work into

### Making it say it doesn't know

Inventing a plausible answer to a question the documents don't cover is the worst
failure mode a RAG system has. If the top similarity from retrieval is below the
threshold (0.62 by default), it refuses without calling the LLM at all. That blocks
the nonsense and saves tokens. I didn't pick the threshold out of the air — I ran
related questions (similarity 0.66–0.74) and unrelated ones (0.53–0.59) against the
sample documents and put the line between the two. When the documents change, I
retune it by looking at the similarity each question leaves in `query_logs`.

There's one exception — attach an image to the question and it doesn't refuse.
This threshold exists to block "answers with no evidence," but when you upload a
screenshot and ask "what's this error," the evidence isn't in the question text —
it's inside the image. Judging by text similarity would block every legitimate
question of that kind, so in that case it answers from the image alone, with no
excerpts (it doesn't slip irrelevant chunks in dressed up as evidence). The
evidence doesn't disappear; it moves from the documents to the image.

```sql
select question, refused, top_similarity from query_logs order by id desc limit 20;
```

### Showing the evidence for every answer

The filename, similarity, and a preview of each excerpt used goes above the answer,
and the body carries [1], [2] markers pointing at them. The sources are sent before
generation starts, so they're visible while the answer is still streaming.

### Vector search with pgvector

No separate vector database — a `vector` column in Postgres, searched with the
`<=>` operator (cosine distance) and an HNSW index. I chose it so document metadata
and vectors live in the same database.

### Overlapping chunking

A sentence cut at a chunk boundary can drop out of retrieval, so I cut at 200 words
with 40 words of overlap. It's a pure function, so it has tests.

### Designing for overload and failure

I implemented Rate Limiter (Token Bucket), Admission Control (concurrency cap +
wait deadline), Bulkhead (three connection pools — readPool, writePool, mediaPool —
so image fetches don't starve question answering), Circuit Breaker (one each for
embedding, cloud generation, and local generation), and Graceful Degradation
myself. I didn't guess at the bottleneck; I put load on it and measured (it was the
DB pool, not the LLM), and pinned each layer's behavior with unit tests.
(`cd server && npm test` — 152 of them)

Measured per measure (50 concurrent connections, LLM mocked out): admission
control cut the pool queue 88 → 6; an open circuit cut mid-outage latency
500 → 190 ms with zero hard errors; the embedding cache turned a 1197 ms miss
into a 0.05 ms hit; moving log writes off the response path cut p99
2794 → 1606 ms (-42%).

The reasoning, the alternatives I compared, and the measurement method are in
[RELIABILITY.en.md](RELIABILITY.en.md).

### Real-time chat

Log in (a guest just picks a nickname and is straight in) and you land in the
lobby; from the room list on the left you join a room or create a new one. The
room list updates live with headcounts, and inside a room you get the
connected-user list, typing indicators, join/leave notices, and the last 50
messages when you re-enter.

I didn't separate "create a room" from "join a room" — enter a name that doesn't
exist and it's created on the spot, and when the last person leaves with no chat
history behind them the room disappears from the list. Leaving empty rooms around
means every name anyone ever used piles up forever, and there's nobody here to
clean that up, so I went with the version that cleans itself.

I separated the visible name from what authorization is based on. Deleting a
room and "unsend" are irreversible (if what you unsend is an image, the bytes go
out of the DB too), and at first I based that permission on the nickname. Nicknames
are fully public — in the bubbles, the connected-user list, the room list — and
nickname registration can be re-sent at any time, so writing down someone else's
name and sending it let you delete their room and wipe their uploaded photo from
everyone. So I split the visible name from what
authorization rests on, and that basis is now the account. What shows in the
conversation is `display_name`; unsend and delete permission is decided only by the
account's user id. The first is public, but the second is proven by an httpOnly
session cookie, so writing down someone else's name gets you nowhere. For the
socket, connecting *is* the authentication: the handshake's session cookie
identifies the user, and the connection is refused if it fails. The question,
document, and image APIs all sit behind that same session too. There are two
exceptions — `/api/metrics` (it carries only aggregate counters, and it's exactly
the place you'd diagnose a "nobody can log in" outage from, so it stays open) and
`/api/kakao/skill` (the caller is the Kakao server, not a browser, so there can be
no session — a token embedded in the skill URL verifies it instead).

It uses the same server and the same port (4000) as the document Q&A. I didn't
split them because a different transport isn't a reason to run one more process.
Merging them actually exposed duplication — the HTTP request limit and the chat
flood limit each had their own copy of the same Token Bucket, so I pulled it into
`server/tokenbucket.ts` and had both share it (with different values per use). The
dashboard shows chat room and connected-user counts alongside the number of
messages blocked as flooding.

### Sending images

Three ways to send an image: file picker, paste (screenshots), and drag and drop.
Images are stored in Postgres as `bytea`.

Bytes don't go over the socket. They're uploaded over HTTP first, and only the
id rides the socket. Put them on the socket and one photo gets copied once per
person in the room, and the last-50-messages history held in memory fills up with
whole images too.

The server makes the URL. The upload returns an id, not a URL. If the client
could choose the URL, it could spray something like
`https://evil.example.com/tracker.gif` across the whole room and make everyone's
browser send a request to somebody else's server. The server checks that the id it
received is one it issued before it attaches a URL.

Format comes from the leading bytes. Filename and Content-Type are both values
the client writes, so I don't trust them. I check the fixed signatures of
png/jpg/gif/webp myself, and I deliberately left SVG out — SVG is XML, so it
can contain `<script>`, and the moment it's served from the same origin it's stored
XSS. Responses also carry `X-Content-Type-Options: nosniff`.

Fetching is isolated in its own connection pool. Image fetches are frequent,
heavy reads that fire every time a message renders, so putting them on the
question-retrieval read pool lets one photo-heavy room starve the exact path this
project said it would defend. Since ids are uuids and the content never changes, I
give them an immutable cache header, so only the first request for each image
reaches the DB.

### Attaching images to questions

In the document Q&A too, you can attach an image to a question the same ways as in
chat — the ＋ button, paste (screenshots), and drag and drop (multimodal
generation). Storage and the upload path are shared with the real-time chat —
upload over HTTP first, and only the id rides with the question.

GIF is blocked only for questions. The upload path is shared with chat, so gif
passes there, but Gemini's image understanding doesn't support gif. Skip the
filter here and the upload succeeds cleanly while only the question blows up with
a 500 — and on top of that, a user's mistake piles up as failures on the LLM
circuit breaker. A few people uploading gifs would open the circuit and degrade
perfectly good questions: a circuit that opens on somebody else's fault.

For how this relates to the refusal gate, see "Making it say it doesn't know"
above — with an image attached, the evidence is the image, so there's no
similarity refusal.

### The generator is a chain — local first, cloud as the last resort

Write `GENERATORS=ollama,gemini` and it tries from the front, moving on to the
next when one fails. On-device first, cloud as the last resort — that
configuration becomes one env line (the default is gemini alone). Assembly happens
in exactly one place, `server/composition.ts` — let each transport (web SSE,
Kakao) assemble its own and you get two quietly diverging systems, like "the web
is local-first but Kakao is Gemini-only."

The switching boundary is "before the first chunk." Switch to another model
after tokens have already flowed onto the screen and you splice on an answer whose
opening repeats and whose style has changed. At that point it doesn't fall back —
it degrades (keep the sources, give up only the generation). There's also a
dedicated local circuit breaker — when Ollama is dead, instead of waiting out the
60-second timeout every time, the circuit opens and it goes straight to the last
resort.

Embedding is a fixed switch (`EMBEDDER=gemini|ollama`), not a chain. Unlike
generation, embedding needs the documents and the question on the same model
(different vector spaces make retrieval meaningless), so fallback is impossible,
and switching means re-uploading the documents.

### KakaoTalk chatbot adapter

The same RAG engine is also exposed as a KakaoTalk chatbot through a Kakao
OpenBuilder skill webhook (`/api/kakao/skill/<token>`). Retrieval, refusal, and
degrade policy are all decided by the core, so a question the web would refuse is
refused in KakaoTalk with the same wording.

The decisive difference from the web is *when to send*. SSE can just let
chunks flow, but OpenBuilder demands one complete JSON within 5 seconds and has no
streaming. So the event stream is collected inside a time budget (3.5 seconds by
default — leaving a share for the network back to Kakao); finish inside the budget
and it's a complete answer, miss it and it hands off to a callback (an
asynchronous reply) or at least delivers a partial answer. The budget collector is
a pure function that knows nothing about express, so it's tested with fake events
alone (`kakao.test.ts`).

The rate limit is keyed on the Kakao user id, not the IP — every request arrives
from Kakao's server IPs, so a per-IP limit becomes one limit shared by every user.
OpenBuilder has no request signing (HMAC), so a secret token in the skill URL
(`KAKAO_SKILL_TOKEN`) verifies it instead. To actually use it, create a channel
and a bot in OpenBuilder and just register the skill URL.

### Pinning the event contract in types

Get an HTTP path wrong and you get a 404 immediately, but socket event names are
strings — write `"typeing"` instead of `"typing"` and nothing happens at all, not
even an error. So I wrapped Socket.IO in generics to have `emit`/`on` names and
payloads checked at compile time. SSE events are nailed down as a union type for
the same reason: if the server adds an event and the frontend forgets to handle it,
type checking catches it.

The server has no build step — Node strips the types and runs it (`node index.ts`).
`tsc` is used only as a checker (`npm run typecheck`).

### Streaming, and handling transient errors

Answers stream over SSE, and every question records its similarity, token usage,
and response time in the DB. With the free tier's rate limit in mind, embedding
requests are sent in batches, and if the API returns a transient error (429, 5xx)
it retries with exponential backoff. I added this after actually hitting a 503 from
the embedding API during development and watching an answer fail. Errors that
retrying can't fix — 400, 404 — go straight to the user instead.

## Stack

- Language: TypeScript (server and frontend both)
- Frontend: React (Vite) · SSE (receiving the streamed answer)
- Backend: Node.js + Express + Socket.IO
- DB: PostgreSQL + pgvector
- AI: Gemini API — `gemini-embedding-001` (embedding) + `gemini-3.6-flash`
  (generation), runs on the free tier. Optionally a local LLM (Ollama) in front of
  the generation chain (`GENERATORS`); embedding swaps with `EMBEDDER`
- Channels: web (SSE) · KakaoTalk OpenBuilder skill (webhook)
- Infra: Docker (local pgvector) · Render (deployment) · GitHub Actions (CI)

## Running it

1. Start the DB (pgvector included; schema.sql is applied automatically on first run)

```bash
docker compose up -d
```

2. Server

```bash
cd server
cp .env.example .env   # set GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
npm install
npm run dev
```

Check that it's up with `curl http://localhost:4000/api/health` → `{"ok":true}`.

3. Frontend

```bash
cd web
cp .env.example .env   # optional — the local demo works with it left empty
npm install
npm run dev   # http://localhost:5173
```

The frontend environment variables are in `web/.env.example`. Vite only reads
`.env*` files under `web/`, so putting a `VITE_`-prefixed value in the server's
`.env` does nothing to the build. Right now there's exactly one value,
`VITE_ADMIN_TOKEN`, for the dashboard's fault-injection buttons, and locally you
can leave it empty because the requests come from loopback. Just be aware that if
you fill it in and deploy, it goes into the bundle in plain text where any visitor
can read it (see the notes in the file).

The first screen is the login — under "게스트로 입장" (guest entry), pick a
nickname and you start right away with no sign-up (on the server a guest is one
account row like any other, so no later logic ever branches on "there might not be
an account").

Upload the three documents in `sample-docs/` and ask something like this. (The demo
app answers in Korean.)

- "How many days does a refund take?" (환불은 며칠 걸려?) → answers from the
  document + shows sources
- "Who pays return shipping?" (반품 배송비는 누가 부담해?) → splits the answer by
  condition
- "I ordered with a virtual account — what's the payment deadline?"
  (가상계좌로 주문했는데 입금 기한이 언제까지야?) → pulls just the relevant
  fragment out of a long document
- "What's the capital of France?" (프랑스의 수도는?) → refused (not in the
  documents)

The first two documents are short (176 and 184 words), so they produce one chunk
each. To actually see the overlapping chunking split something, upload the third
one (`자주-묻는-질문.md`, "frequently asked questions" — 470 words → 3 chunks) and
look at the chunk count in the list.

Real-time chat is under the "실시간 채팅" (Real-time chat) tab at the top. Open two
browser tabs, join with the same room name, and the messages go back and forth.
Text chat works without a DB; sending images needs the `chat_images` table
(included in schema.sql).

If the DB schema didn't get applied (because the volume was created first):

```bash
docker exec -i docchat-db psql -U postgres -d docchat < server/schema.sql
```

## Project layout

```
server/
  index.ts            Express app + Socket.IO attached, /api/health, /api/metrics,
                      router registration (rateLimit → requireLogin order), error middleware
  types.ts            SSE event union, /api/metrics response type (one place)
  composition.ts      composition root — the one place that decides the engine's
                      parts, the generator chain (GENERATORS), and the threshold
                      (web and Kakao share the same engine)
  db.ts               pg connection pools — split into read/write/media (Bulkhead)
  auth.ts             accounts & sessions — scrypt hashing, session cache, requireLogin, cookies
  gemini.ts           Gemini embedding / streaming generation / exponential-backoff retry
  ollama.ts           local LLM (Ollama) embedding & generation client
  embedding.ts        embedding provider switch (EMBEDDER) + goes through the question vector cache
  prompt.ts           answer prompt assembly (shared by Gemini and Ollama)
  kakao.ts            Kakao skill payload parsing & time-budget collection (pure — knows no express)
  chunk.ts            overlapping chunking
  cache.ts            question embedding cache (TTL)
  imagetype.ts        format from the leading upload bytes (SVG excluded)
  images.ts           chat image store/fetch (the DB-aware code is confined here)
  tokenbucket.ts      Token Bucket algorithm — shared by eight HTTP and socket limits
  ratelimit.ts        per-user (IP) HTTP request limit
  clientip.ts         picking the real client IP behind a proxy (for sockets)
  origins.ts          origin allow decision — shared by HTTP, socket, CSRF checks
  admission.ts        concurrency cap + wait deadline (load shedding)
  breaker.ts          circuit breakers — embedding, cloud generation, local generation
  admin.ts            protection for the fault-injection endpoint (token / loopback)
  faults.ts           runtime fault-injection switches (for the demo)
  rag/
    types.ts          core values and ports (imports no express / pg / genai)
    engine.ts         question → event stream. search, refusal, degrade policy
  adapters/
    embedder.ts       Embedder port = embedding + circuit
    store.ts          VectorStore port = pgvector cosine search
    generator.ts      AnswerGenerator port = Gemini & Ollama generation + circuit + fallback chain
    logger.ts         QueryLogger port = query_logs writes
  routes/
    auth.ts           /api/auth — sign-up, login, guest entry, logout, me
    documents.ts      upload, list, read original (GET), edit (PUT), delete
    chat.ts           wires the core to HTTP/SSE (transport, admission, image loading only)
    kakao.ts          Kakao skill webhook — 5s budget + callback fallback + partial answers
    images.ts         chat image upload (POST) / fetch (GET, immutable cache)
  realtime/
    types.ts          socket event contract (paired with web)
    gateway.ts        connect (handshake = session auth) / join / broadcast / leave handlers
    rooms.ts          room state (50 messages + connected users) in memory
    ratelimit.ts      per-IP flood & handshake limit (budget survives a disconnect)
    payload.ts        safe socket payload parsing (shape checks at the boundary)
  scripts/            load test, cache bench, defense layer demo
  schema.sql
  tsconfig.json       no build — Node strips types and runs, tsc only checks
  *.test.ts           152 unit tests
                      (RAG core · core boundary · chunking · token bucket · rate limit
                       · breaker · admission · rooms · imagetype · socket payloads
                       · client IP · origin decision · socket flood limit
                       · accounts/sessions · Kakao adapter · Ollama stream
                       · generator fallback chain)
web/
  src/
    types.ts          contract matched to the server (documents · SSE events · metrics)
    api.ts            fetch + SSE parsing + auth calls (401 → back to the login screen)
    images.ts         image-attachment frontend util (upload → id)
    App.tsx           top tabs behind AuthGate — document Q&A / real-time chat / dashboard
    components/       AuthGate (guest·login·sign-up) / Sidebar (upload/list) / Chat
                      Message (shows sources) / DocModal (view/edit popup)
                      Dashboard (load & fault dashboard)
    realtime/
      types.ts        socket event contract (paired with server)
      socket.ts       typed socket (connects to the same origin)
      session.ts      tab storage (last room name)
      LiveChat.tsx    socket connection management + lobby → room
      RoomList.tsx    room list + create a new room
      Room.tsx        subscribe / send / connected users
  vite.config.ts      /api proxy + /socket.io proxy (ws)
sample-docs/          fictional shopping-mall documents for the demo
                      (two short ones + one that chunking actually splits)
docs/                 screenshots for the README and portfolio
docker-compose.yml    Postgres with pgvector
.github/workflows/    CI — type check, test, build on every push and PR
```

Click an entry in the document list and a popup opens where you can edit the
original text and save it in place. Saving re-chunks and re-embeds just that
document and reflects it in search. The original can't be reconstructed from the
chunks (they overlap), so it's kept separately in `documents.content`.

## Limits, and what I'd try next

- No conversation context (multi-turn). It works one question at a time.
- PDF parsing quality is too variable, so I stuck to txt/md.
- Retrieval depends on embedding similarity alone. I'd like to try hybrid search
  next, mixing in BM25 keyword search.
- I tune the refusal threshold by hand while reading logs. Building an evaluation
  question set and measuring it automatically is the next goal.
- Chat history lives only in server memory, so it's gone on restart. The staged
  plan I have in mind is ① now: single-server in-memory (rooms, messages, presence,
  flood protection) → ② persist messages to Postgres for durability → ③ add the
  Socket.IO Redis adapter for pub/sub and move presence to Redis so messages reach
  users connected to a different server. It's the same kind of limit as the
  embedding cache being in-memory.
- There is login, but no per-document access control. The session only answers
  "is this someone who got in"; `documents` has no owner or group column, so
  everyone who logs in sees the same corpus. Rather than pretend a filter exists,
  the store adapter refuses scoped search outright — but until that column exists,
  authorization is simply absent.
- The server and the frontend each keep their own copy of the event contract types.
  At this size the cost of introducing a workspace is higher than the duplication,
  so I deferred it; if it grows I'll pull them into a shared package.
- Verification is still at the unit-test level. Behavior like socket origins or
  CSRF only shows up with a server actually running, and I reproduced those by
  hand; lifting them into integration tests is the next candidate.
- Deployment: Neon (pgvector support) + Render free tier. The frontend (the React
  build output) and the backend are served from a single Render service — web/api.ts
  and realtime/socket.ts assume relative paths and the same origin, so splitting the
  frontend onto separate static hosting would mean baking the backend's absolute URL
  into that code. Being on the free tier, the server sleeps after a while without
  traffic and takes time to wake (see the live demo link above).
