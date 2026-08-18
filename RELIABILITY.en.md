[한국어](RELIABILITY.md) | [日本語](RELIABILITY.ja.md) | **English**

# DocChat — Load and failure handling design

The one-line principle of this document: when overloaded or failing, always make
the system choose "some requests get slower or rejected" over "everyone dies
together."

Every number below came from putting load on it myself. The tools and the commands
to reproduce them are at the bottom.

A note on the measurement environment first. The latency numbers in this document
(1788ms average, pool queue depth 88, p99 2794 → 1606ms, cache miss 1197ms) were
taken with the DB on Neon (cloud Postgres). The `docker compose up -d` path the
README describes is a local Docker Postgres with no network round trip, so running
the same commands gives lower latency than this (and therefore a different
concurrency level at which the bottleneck shows up). Read them not as absolute
numbers to reproduce, but as "where the bottleneck was, and which direction each
change moved it, and by how much."

---

## 0. Starting point — I measured the bottleneck first

I didn't optimize on guesses. I put load on it first and measured where the
bottleneck was.

I replaced the external LLM (generation) with a mock — to take out the part I can't
make faster and measure only the part I control — and hammered it with 50
concurrent connections. Result:

- Even with the LLM removed, every request averaged 1.8 seconds and the connection
  pool queue piled up to 88.

So the bottleneck was the DB, not the LLM. Every request round-trips a query to
Neon (cloud Postgres), and the pool (max 10) was saturated. That one measurement
became the basis for every decision after it.

Without measuring, I'd have assumed "the LLM must be slow," optimized only the LLM,
and spent the time in the wrong place.

---

## 1. Defense layers — the order a request passes through

```
request
  │
  ▼ [1] Rate Limiter (per user)     stop one user's flood from paralyzing everyone, at the front
  │
  ▼ [2] Admission Control (global)  cap on concurrency. Over it, immediate 429 instead of waiting forever
  │
  ▼ [3] Bulkhead (resource isolation)  split read/write/media pools. Write and image floods don't block questions
  │
  ▼ [4] Circuit Breaker (embedding)  if embedding keeps failing, fail fast without calling it
  │                                  (if this dies we can't even retrieve, so degradation isn't possible)
  │
  ▼ [5] Retrieval + refusal gate    if nothing is relevant, don't call the LLM (less load + no nonsense)
  │
  ▼ [6] Circuit Breaker (generation)  if the LLM keeps failing, open the circuit and substitute a response
  │
  ▼ [7] Generation (Degradation on failure)  even if the LLM fails, return the sources. Nobody leaves empty-handed
```

The first three are prevention (don't collapse); the last three are degradation
(don't die when you overflow). Why there are two circuits is in section 4 — even
with the same vendor, what you can do when one fails is different. You can inject
these layers with buttons on the dashboard and watch them react live (section 9).

That order is the HTTP question path. A real-time chat message goes through the
same algorithm as [1] with different values (section 2) and skips the rest of the
layers — it touches neither the LLM nor the DB.

---

## 2. Rate Limiter — blocking one user's flood (Token Bucket, hand-rolled)

Files: server/tokenbucket.ts (algorithm), server/ratelimit.ts (HTTP),
server/realtime/ratelimit.ts (chat flooding)

What I was worried about (P)
One malicious user or one buggy client firing hundreds of requests per second
paralyzes the whole server. One person's mistake turning into a total outage has to
be stopped at the very front.

What I decided and why (A)
I compared three algorithms.
- Fixed window counter: at the window boundary you can get twice the limit in an
  instant.
- Plain immediate rejection: people naturally send in bursts, so blocking normal
  bursts is annoying.
- Token Bucket: allows an instantaneous burst up to the bucket capacity, but tokens
  refill at a fixed rate per second, so the average rate is firmly limited. It
  satisfies burst tolerance and average limiting at the same time.
I implemented Token Bucket myself. The reason I wrote it instead of using a library
is that it's the most direct evidence in code that I understand the algorithm.

One more piece got attached later. When I merged the real-time chat into the same
server, it turned out the per-socket flood limit had its own copy of exactly the
same Token Bucket as the HTTP request limit. I pulled the algorithm out into
server/tokenbucket.ts so a single `TokenBuckets` class is shared by both. More
important than removing the duplication is that this is when it became clear what
had to be the same across the two paths and what had to differ.

| | HTTP question (ratelimit.ts) | Chat message (realtime/ratelimit.ts) |
|---|---|---|
| Capacity (instant burst) | 10 | 5 |
| Refill per second | 5 | 2 |
| Bucket key | IP | IP (connections are counted separately for the concurrent-connection cap) |
| Bucket reclamation | sweep — cleaned after 10 minutes idle | sweep — same |

Why the values differ: an HTTP question is expensive (an embedding plus an LLM
round trip) and arrives rarely. A chat message is cheap and arrives often. And yet
I made the chat burst *narrower*. One person flooding doesn't just slow themselves
down — it covers the screens of everyone else in the room. In effect I set the
limit by how far the damage spreads when it overflows, not by how expensive the
request is for the server.

The story of changing the key, and of fixing it only halfway.

At first the chat bucket's key was `socket.id`. Judged only on reclamation accuracy
that looked right, but as a limit it was doing nothing at all. `socket.id` is new on
every connection, so firing 5, disconnecting, and reconnecting gets you a fresh full
bucket — I actually sent 20 that way and every one of them went through. So I
changed the key to something that follows you across reconnects (the IP).

I wrote "fixed" at that point, and it was only half fixed. Because I'd left
reclamation on `drop()` — counting the live sockets per IP and deleting that IP's
bucket when the last one disconnected. A socket has a clear termination signal in
disconnect, so cleaning up exactly then seemed tidy. But for someone connected
alone, that "last socket" is themselves, so the budget disappeared the moment they
disconnected and was full again when they came back. I'd changed only the key; the
bypass was still alive. Measured over the same wall-clock time with the same
volume: 9 messages went out on a held connection while 20 went out by disconnecting
and reconnecting.

So reclamation changed to the same idle `sweep(idleMs)` the HTTP side uses, and the
behavior is pinned in `realtime/ratelimit.test.ts` ("disconnecting and reconnecting
doesn't give the budget back"). Live socket counts are still tracked, but now
they're used only for the concurrent-connection cap per IP.

Two rules came out of this.
**Key on something the attacker can't change, and give the limit a longer life than
the connection.** Knowing that a connection ended doesn't mean you get to forget
"the budget this person spent." A termination signal is a valid basis for deciding
*when* to reclaim, and an invalid basis for erasing a limit. And one more —
**behavior that the docs say is "blocked" quietly comes undone unless a test pins
it.** This item had come undone in exactly that way.

For the same reason there's a cap (10 by default) on concurrent sockets per IP.
Without it you can multiply the per-IP limit just by opening more connections.

I pinned one thing in the API too. `take()` returns
`{ ok: true } | { ok: false; retryAfterSec: number }` rather than a boolean. That
writes "the wait time exists only when it's a rejection" into the type, so the
compiler stops you if you try to read `retryAfterSec` on a pass. The mistake of
filling the Retry-After header with an empty value can't happen in the first place.

Result (R)
With capacity 10 and refill 5 per second, I fired 15 at once from one IP.
- 10 through, 5 rejected (429). Exactly the bucket capacity got through and the rest
  were blocked with 429.
Messages blocked as chat flooding are counted separately as
`realtime.messagesRejected` on /api/metrics.

---

## 3. Admission Control — fast rejection instead of unbounded waiting

File: server/admission.ts

What I was worried about (P)
As the step-0 measurement showed, concurrent requests pile the pool queue up
without limit. Leave it that way and every request's latency explodes until they
all die together on timeouts (cascading failure).

What I decided and why (A)
- Unbounded queue: latency grows without limit. Worst option. Out.
- Immediate rejection only: even a momentary spike bounces everyone, which is a bad
  experience. Out.
- Concurrency cap + short queue + 429 over that: absorb momentary spikes with the
  short queue and defend against sustained overload by rejecting. I took this
  compromise.

And I added one more thing — a limit on the **time** in the queue.
At first I limited only the queue length, and then realized that alone doesn't let
me claim I'd eliminated unbounded waiting. Even with 20 slots, if the requests
ahead get slow the ones behind wait arbitrarily long. The length is finite while
the time can be infinite. So waiting gets a deadline (2 seconds by default), and if
no slot opens within it the request gives up waiting and goes back with a 429. By
then the user has left anyway, and processing it late just spends resources on a
response nobody will collect.

That's why I observe two kinds of rejection separately. Bounced **immediately**
because the queue was full (`rejected`) is a signal that overload is sustained;
giving up at the **deadline** after waiting (`timedOut`) is a signal that processing
itself got slower. Different causes, so different responses.

Result (R) — 50 concurrent connections, before/after
| | No overload control | With it (concurrency 8, queue 20) |
|---|---|---|
| Pool queue depth | 88 (still climbing) | 6 (stays shallow) |
| Average latency | 1788 ms | processed requests stay normal |
| Excess traffic | all piles into the queue | immediate 429 + Retry-After |
| Server errors (5xx) / timeouts | 0, but on the edge of collapse | 0, stable |

The point is that "no control" also shows 0 5xx right now, but a queue that has
piled up to 88 means a little more traffic brings it down. "With control" accepts
only as much as it can process and sends the rest straight back (telling them when
to return via Retry-After), keeping the queue shallow. It doesn't collapse.

---

## 3-2. Bulkhead — isolating resource pools

File: server/db.ts

What I was worried about (P)
If everyone shares one connection pool, one kind of work eating all the connections
stops the other kinds too. If document uploads or log writes (slow, and prone to
bunching up) monopolize connections, user questions (retrieval) can't get one and
the whole chatbot stops.

What I decided and why (A)
Like the watertight bulkheads on a ship, I split the pools by purpose. readPool for
question retrieval (the thing to defend) and writePool for uploads and log writes,
kept separate. Even if writes flood and saturate writePool, readPool is untouched
and question answering continues.

Adding images to chat added one more pool (mediaPool). Image fetches are "reads,"
but I didn't put them on readPool, because they're a completely different animal —
question retrieval fires once when a user clicks once, while an image fetch fires
every time a message renders and each one is hundreds of KB. One room with a lot of
photos eating readPool starves the path this document called "the thing to defend"
in its first lines. Attaching traffic of a different character next to a resource
you've declared you'll protect is building a bulkhead and leaving the door open.

I set mediaPool's max small, at 4, not because that's enough but to pin a ceiling.
Image ids are uuids and the content never changes, so they can carry an immutable
cache header, which means only the first request for each image reaches the DB. In
steady state this pool is nearly empty; it only hits 4 during a flood.

Result (R)
/api/metrics exposes the waiting count for all three pools separately. On the
dashboard you can watch a write flood pile up waiting on writePool only, while
readPool stays at 0.

---

## 4. Circuit Breaker — don't keep knocking on a dead dependency

File: server/breaker.ts

First, the hole this layer had. The circuit was on **generation (the LLM) only**.
But the question path goes out to the network in two places — the embedding that
turns the question into a vector, and the generation that produces the answer. The
embedding call sat outside the circuit (ahead of the `isOpen()` check), so when the
embedding API died the circuit never opened, and every request burned its full
retry ladder (0.5 + 1 + 2 seconds) before returning a 500. Holding a processing slot
the whole time. Free-tier embedding 429s are an everyday event, so this was a path
that actually got walked, and this document's claim that it "doesn't cling to dead
dependencies" was exactly half true.

Merging them into one circuit wasn't an option either. What you can do when each
one fails is different.

| | If it fails | So |
|---|---|---|
| Generation | the sources are already retrieved | give up the answer only and return the sources (degradation) |
| Embedding | you can't even start retrieval | there are no sources to return → failing fast is the best you can do |

Tie them together and a generation outage blocks embedding too, so you can't return
sources even when you could have — which makes the Graceful Degradation in section
5 useless. So the circuit was split in two (`breaker.llm`, `breaker.embed`) and each
does the best it can. The dashboard shows both states.

What I was worried about (P)
When the external LLM fails, retries compound and every request hangs for seconds
before failing. Slow requests pile up in the meantime and the whole server slows
down with them. Most large outages are the case of "kept calling a dead dependency
and collapsed in a chain."

What I decided and why (A)
When consecutive failures pass the threshold (5), the circuit opens and the LLM
isn't called at all for a period (10 seconds). During that time requests go straight
to a substitute response. After the cooldown it tries again and recovers
automatically if things are healthy. In production I'd use a proven library like
opossum; here I wrote a minimal implementation to show I understand the pattern
directly.

Result (R) — injected a fault where the LLM "hangs 300ms and fails," 9 requests
```
#1-4  degraded  ~500ms   breaker closed (consecutive failures 1→4)
#5    degraded  ~500ms   breaker OPEN   (5 consecutive failures → circuit opens)
#6-9  degraded  ~190ms   breaker OPEN   (LLM not called → latency drops hard)
```
After the circuit opened, latency fell from about 500ms to about 190ms. Giving up
quickly instead of continuing to knock on a dead API means the server doesn't slow
down even during an outage.

---

## 5. Graceful Degradation — don't send people away empty-handed

File: server/rag/engine.ts (degrade)

What I was worried about (P)
If the LLM dies and all the user gets is "error," the user gets nothing. For a
service that can't afford a single misstep, "give up some functionality" always
beats "die."

What I decided and why (A)
I set priorities.
- Defend at all costs: retrieving relevant documents and providing sources (this
  works without the LLM)
- First to be given up: the summarized answer the LLM produces
So sources are sent before the answer, and if generation fails or the circuit is
open, only the answer generation is abandoned and it finishes with "please check
the sources directly."

Result (R)
In the section 4 experiment, all 9 responded degraded (sources returned) rather
than as hard errors. Even with the LLM completely dead, the user always gets the
relevant documents. Error rate 0.

---

## 6. Optimizations on the prevention side (question path)

### Embedding cache (server/cache.ts)
P: Calling the embedding API again every time the same question repeats means a
   network round trip each time plus pressure on the rate limit.
A: Cache the question embedding. In-memory for now (node-cache); when there's more
   than one server, swap in Redis (only get/set/stats are exposed, so calling code
   doesn't change).
R: Measured against real Gemini — cache miss 1197 ms, cache hit 0.05 ms. Removes
   about 1.2 seconds per repeated question.

### Moving log writes off the response path (server/adapters/logger.ts)
P: Every question writes an observability log to the DB, and waiting for that write
   was delaying the user's response.
A: Logs are written in the background after the user has received the whole answer
   (fire-and-forget). Storing observability data came out of the user's latency
   path. In effect, separating the write and read paths (the bulkhead idea).
R: 20 concurrent connections — throughput 20 → 24 RPS, p99 latency 2794 → 1606 ms
   (a 42% drop).

### Connection pool tuning + timeouts (server/db.ts)
Connection cap (max), idle return (idleTimeout), and connection acquisition timeout
(5 seconds) are all set explicitly. Without a timeout, requests pile up waiting
forever under load. Failing when a connection can't be acquired within 5 seconds
drains them quickly instead.

### HNSW index (server/schema.sql)
Vector search runs on an HNSW index, so growing the number of chunks doesn't mean
scanning all of them — it finds approximate nearest neighbors.

---

## 7. How I measured (reproducible)

Monitoring is decision-making power. You have to see which layer fired and when to
find the cause of an outage within seconds. GET /api/metrics exposes cache hit
rate, pool state, rate limit rejection counts, current concurrency, circuit state,
and the real-time chat side (`realtime` — room count, connected users, messages
blocked as flooding) all at once. (Prometheus + Grafana in production.)

```bash
cd server                     # there's no package.json at the root. Everything below is relative to server/

# unit tests for the defense layers (109)
npm test

# cache effect (real Gemini)
npm run bench:cache

# load test (needs the mock server)
npm run start:mock            # in another terminal
CONN=50 DUR=10 npm run loadtest

# defense layer demos
MODE=burst   COUNT=15 node scripts/demo-defense.ts   # Rate Limiter
LLM_FAIL=1 npm run start:demo                        # fault-injection server
MODE=breaker COUNT=9  node scripts/demo-defense.ts   # Circuit Breaker + Degradation
```

Why the breaker demo uses `start:demo` instead of `start:mock`: the mock embedding
is seeded random, so its similarity against any stored chunk comes out near 0, and
at the default threshold (0.62) every request ends at the refusal gate without ever
calling the LLM — the circuit can't open, and all you're measuring is the refusal
path. `start:demo` opens that gate with `SIMILARITY_THRESHOLD=-1` so requests reach
generation (and stretches the cooldown to 30 seconds to make the open window easier
to see).

The load tool is autocannon (Node); production-grade scenarios can be extended with
k6 or Artillery. The server has no build step. Node strips the types and runs
`node index.ts` directly, and `tsc` is only a checker (`npm run typecheck`). The
paths in the commands above are the source paths.

### What I pinned with tests rather than measurements (109)

A measurement only shows "this is the number right now"; it doesn't guarantee the
behavior is still the same in the next commit. So when each layer should fire is
pinned by unit tests.

| File | Count | What it pins |
|---|---|---|
| realtime/rooms.test.ts | 31 | No ghost users, empty rooms cleaned up, history capped at 50, room isolation, no unbounded room growth, the same nickname still can't delete someone else's |
| breaker.test.ts | 9 | Circuit opens at the threshold, recovers after cooldown, only one trial request while half-open |
| tokenbucket.test.ts | 8 | The algorithm itself — burst tolerance, token refill, per-key isolation, drop/sweep reclamation |
| imagetype.test.ts | 8 | Upload format detection — disguised SVG and HTML rejected, doesn't blow up on truncated files |
| clientip.test.ts | 8 | Picking the real IP behind a proxy — which way it breaks when the hop count is wrong |
| admission.test.ts | 6 | Concurrency cap, immediate rejection when the queue overflows, the wait deadline |
| realtime/payload.test.ts | 6 | Handlers survive socket payloads that are null, a number, or an empty object |
| origins.test.ts | 8 | Other origins blocked, same origin (our own screen, deployed together) allowed |
| realtime/ratelimit.test.ts | 5 | Flood budget doesn't come back after disconnect and reconnect, cap on concurrent connections per IP |
| ratelimit.test.ts | 4 | Whether that algorithm is attached to HTTP correctly — 429, Retry-After header, IP as the key |
| chunk.test.ts | 3 | Document splitting |

The last three files listed here (clientip, origins, realtime/ratelimit) were added
later, and for the same reason — all three are places where **behavior this document
recorded as "blocked" had actually come undone.** After confirming three times that
a claim left as prose quietly disappears in the next commit, I moved my standard to
attaching a test to every behavior I claim.

imagetype.test.ts looks more at "does it reject what it should reject" than at "does
it accept what it should accept." Letting through something that shouldn't get
through is the most expensive mistake in this project — bytes a user uploaded get
served back to a browser from the same origin later.

realtime/payload.test.ts was added later too, and for a reason. The socket handlers
were destructuring their arguments inline (`socket.on("message", ({ text }) => ...`).
By the types, `{ text: string }` is what arrives, but that's a compile-time promise
and the value coming down the wire can be anything. When `null` arrives, the
destructuring throws a TypeError right there, and since Socket.IO calls listeners
without a try/catch it becomes an uncaughtException and **the whole process dies**.
One line of `socket.emit("message")` in a browser console disconnected everyone.
hello, join, and image were the same. What this test protects is availability, not
convenience.

Extracting the algorithm split the tests in two as well. Whether the algorithm is
correct and whether it's attached to HTTP correctly are different questions, so they
are verified in different files.

There's one thing I was careful about here. The Token Bucket test has to check
"were tokens refilled after 1 second," and actually waiting a second makes tests
slow and intermittently flaky in CI when timing is tight. So I made it take the
clock as an argument, `take(key, now)`. The test pushes the clock forward as far as
it likes and looks at the result — no waiting, and the same result every time.
`sweep(idleMs, now)` takes a clock for the same reason. You can't wait 10 minutes to
check that 10-minute idle reclamation works. Logic that depends on time has to have
time injected into it to be tested deterministically.

---

## 8. What I didn't do, and why (scope)

Implementing all of this on real infrastructure with zero years of experience is
overkill. Knowing what I left out and why matters more.

- Bulkhead: actually implemented as separate read / write / media pools (db.ts).
  Splitting it more finely by feature is for when the server grows.
- Autoscaling: a new server takes tens of seconds to come up, so it can't follow a
  sudden spike. Predictable heavy traffic calls for a decision to scale up in
  advance — that's infrastructure territory, so it stays as design only.
- Redis (shared cache + Bull queue): once there's more than one server, in-memory
  caches and queues drift apart per instance, which is a limit. That's when Redis
  comes in. (The Cosmos Tarot project I looked at is set up that way.)
- Prometheus + Grafana: /api/metrics (JSON) is enough for now. Dashboards are an
  operations-stage concern.
- Pub/Sub · message loss prevention: this used to be an item I'd written off as
  "not applicable, DocChat is document Q&A," but with real-time chat attached, one
  of the three — presence (the connected-user list) — actually got implemented. The
  other two still haven't been. Room state lives in server memory and each room
  keeps only the last 50 messages. When everyone leaves and there's no history, the
  room itself is deleted to prevent a memory leak. Scaling to several servers would
  mean moving room state to Redis (and that's when Pub/Sub becomes necessary), which
  is exactly the same kind of limit as the embedding cache (cache.ts) being
  in-memory — meaning both are choices that assume a single server.
  That said, the principle underneath ("what you can't afford to lose goes in
  durable storage, what's fast goes in temporary storage") is already honored —
  documents and chunks are stored durably in Postgres in transactions, and only the
  embedding cache and chat history, which are fine to lose, sit in memory (losing
  them means a regeneration, i.e. a cache miss, or recent conversation disappearing).
  So even when Redis does come in, it will be for the cache, room state, and log
  queue — not the data itself. Filtering someone else's architecture advice for the
  kind of system you actually have is a design judgment too.

---

## 9. Live dashboard — inject a situation and observe the reaction

Files: web/src/components/Dashboard.tsx, server/index.ts (admin endpoints)

There's a dashboard tab on the frontend. It polls /api/metrics every second and
draws the four defense layers and the metrics in real time. Buttons inject
situations.
- "Traffic burst (20 concurrent)": fires 20 at once → the Rate Limiter blocks the
  excess with 429 and the layer lights up yellow.
- "LLM fault ON": makes generation fail → requests respond degraded (sources only),
  and once consecutive failures pass the threshold the Circuit Breaker opens in red
  (with a retry countdown).
- "Reset": clears the fault and resets the circuit.

The Rate Limiter panel shows HTTP rejections and chat flood blocks together
("per-user request limit (HTTP · socket shared)"). The two paths share the same
algorithm, so the dashboard groups them into one panel too. Which side did the
blocking is written out as separate numbers.

Why I built it: monitoring is decision-making power. If you can't see *when* the
defense logic fired, you can't judge what's wrong within seconds during a real
outage. This dashboard is a scaled-down way to practice that judgment. (Prometheus
+ Grafana in production.)

![The dashboard while an LLM fault is injected](docs/demo-dashboard-breaker.png)

This screen is the part of the portfolio that shows "how the system holds up under
overload and failure" as a moving picture rather than words.

### Keeping a demo feature from becoming a production hole (server/admin.ts)

The fault-injection endpoint (`/api/admin/fault`) is a switch that deliberately
breaks the service. The demo needs it, but if it's left open on a deployed server
anyone can take the service down. It's the textbook case of one convenience feature
becoming a vulnerability as-is.

So it's secure by default, in two stages.
- If `ADMIN_TOKEN` is set: the token has to match (deployed environment)
- If it isn't set: only requests from loopback (localhost) pass (local demo)

The point is "which way does it lean when you forget to configure it." I chose a
design where forgetting to turn on the token check leaves it closed from outside,
rather than one where forgetting leaves it open and exposed.

One more judgment call: the loopback check uses `req.socket.remoteAddress`, not
`req.ip`. This server sits behind a load balancer when deployed, so `trust proxy` is
on, and then `req.ip` follows the `X-Forwarded-For` header, which the client can put
whatever it wants in. You don't base authentication on a spoofable value.

### That `trust proxy` value was itself wrong

The same principle applies outside authentication. Set `trust proxy` to `true`
(trust every hop) and a client can inject `X-Forwarded-For` itself to make `req.ip`
a different value on every request, and the Rate Limiter that buckets by IP
(section 2) sees "a new user every time" and is bypassed entirely. So the code
default is `0` (trust nothing), and only when it sits behind a load balancer do you
give `TRUST_PROXY` a hop count — that's what I'd written, while **the deploy config
(render.yaml) had no such value in it and the live demo was running that way.**

The result was a failure in the opposite direction. Render terminates TLS at the
edge and passes plaintext to our server, so with 0 trusted hops every visitor's
`req.ip` collapses into that one proxy address. "Per-IP limiting" became "one shared
global limit" — one visitor asking a few questions empties the bucket (capacity 10)
and other visitors get 429s, and because of the concurrent-socket cap per IP (10 by
default), **the 11th visitor anywhere in the world had their chat connection
rejected.**

And filling in the environment variable didn't fix the socket. `trust proxy` is an
Express setting, so it applies only to `req.ip`, while `socket.handshake.address` is
whatever engine.io passed through from the TCP connection and knows nothing about
that setting. So I moved the calculation Express does (the same rules as
proxy-addr) into `server/clientip.ts` as a pure function, so the socket side decides
the IP by the same standard, and pinned what happens when you count hops wrong with
8 tests.

The lesson of this item is at the boundary, not in the code — **configuration goes
wrong more quietly than code does, and one framework's setting doesn't protect the
framework next to it.**

### The socket origin was the same kind of thing

When I fixed having locked down HTTP while leaving the socket at `origin: "*"`, I
gave Socket.IO a `cors` option and wrote that it was blocked. It wasn't. engine.io
uses the cors middleware only to attach headers, and if the origin isn't in the list
it omits the headers and just passes it along — the request is processed as normal.
On top of that, browsers don't apply CORS to the WebSocket handshake, so a client
pinned to the websocket transport skips the check entirely. You could connect from
any origin, get the room list, and send messages.

Rejecting in `allowRequest`, which is called before the handshake, blocked both
transports. There was one more trap here: deployment serves the frontend from the
same origin, so our own screen's Origin is our own address, and that isn't in the
`CORS_ORIGINS` list — if I'd judged by the list alone, turning the check on would
have killed the whole live demo. So the decision is "pass if it's in the allow list,
or if it equals the request's Host," and `server/origins.test.ts` records both sides
(what must be blocked and what must pass).

I attached the same decision to state-changing HTTP requests too. The cors
middleware doesn't reject, so requests that don't get a preflight (a POST with no
body, a multipart upload) executed fine from someone else's site — with the server
running locally, visiting any page could have that page call `/api/admin/reset` or
push a file into my document list.

A limitation, noted: for the dashboard buttons to work in a deployed environment the
token has to go into the frontend build (`VITE_ADMIN_TOKEN`), and any value in the
build can be read out of the bundle by any visitor. Which means the moment you put
the token in the frontend, that deployment has chosen to "expose the fault-injection
demo to visitors." To lock it from outside, leave the token out of the frontend (the
buttons stop working) and call it directly with the server token (curl) when needed.
Either way, choosing consciously is what matters — this demo is a screen built for
visitors to press, so I chose the exposed side.

---

## 10. Alternatives and trade-offs — why I chose this, and when I'd change

No layer here is "the correct technology." There are alternatives, and the
trade-offs differ. For each choice, the alternative and "when I'd switch to it."

| Layer | My choice | Alternatives | When to switch |
|---|---|---|---|
| Rate Limiter | Token Bucket, hand-rolled | Sliding Window, Leaky Bucket, rate-limiter-flexible (library), nginx / API Gateway (infrastructure) | Leaky Bucket if bursts must be blocked outright (payment APIs) / a library once there are several backends |
| Admission Control | Fixed-cap semaphore | Adaptive (Netflix concurrency-limits, AIMD like TCP congestion control), p-limit/p-queue | Adaptive self-tunes when you can't determine the right cap in advance |
| Bulkhead | Read / write / media pool split | PgBouncer (external pooler), physical service separation | External pooler with several servers / service separation with large traffic |
| Circuit Breaker | Hand-rolled | cockatiel (breaker + retry + timeout + bulkhead in one, newer than opossum), Envoy outlier detection (infrastructure) | A proven library in production / infrastructure with a service mesh |
| Embedding cache | node-cache (TTL) | lru-cache (proper LRU eviction), Redis (shared cache) | lru-cache if memory pressure needs LRU / Redis with several servers |
| Log writes | fire-and-forget | BullMQ + Redis (durable queue) | A queue once losing logs is a problem |
| Vector index | HNSW | IVFFlat (faster build, less memory, lower accuracy), dedicated vector DB (Qdrant and friends) | IVFFlat if the data changes often / a dedicated DB at tens of millions of vectors |

One axis runs through all of it: write it in application code, or hand it to
infrastructure (API Gateway, service mesh). This document chose application code
everywhere. The reason is clear — the purpose of a portfolio is to prove in code
that I understand the pattern. In a large production service, much of the rate
limiting and circuit breaking moves up to infrastructure like Envoy or an API
Gateway. To "why did you write it in code instead of infrastructure," my answer is
that proving understanding was the goal at this scope, and moving to infrastructure
is the right call when it scales.

Not using a modern library (cockatiel and the like) and writing it myself is the
same reasoning. In production, a proven library is correct. But writing it myself is
what lets me explain why this threshold and what the trade-offs are. If I were using
a library, explaining "why this library, and how I set the thresholds" would matter
instead.

Two things worth flagging:
- The weakness of fire-and-forget logging: if the server dies in the instant after
  the response goes out, that log is gone. It's perfect from a latency standpoint
  and gives up durability. When the stage arrives where logs can't be lost, I'd
  switch to a BullMQ + Redis queue so they survive in the queue and get processed
  after a restart.
- Bulkhead and PgBouncer: this project's Neon connection string already goes through
  a pooler (`-pooler`). So on top of the application-level read/write/media split,
  there's already an infrastructure-level external connection pooler underneath. The
  total connection count stays controlled even as the number of servers grows.

---

## What I did → what came out of it (one-line summary)

| Decision | Result |
|---|---|
| Measure the bottleneck instead of guessing | Confirmed the bottleneck was the DB pool, not the LLM (queue 88) |
| Hand-rolled Token Bucket rate limiting | 15 from one IP → 10 through, 5 rejected |
| Extracted Token Bucket into a shared module | HTTP and chat share one algorithm, only the values differ by use |
| Admission control instead of an unbounded queue | Queue 88 → 6, the excess gets an immediate 429 |
| A cap on wait time, not just queue length | Give up past the deadline; immediate rejection and wait-timeout observed separately |
| Read / write / media pool isolation (bulkhead) | Write and image floods don't block question retrieval |
| Circuit breaker on the LLM | Circuit opens after 5 failures, latency 500 → 190ms |
| Split the circuit into embedding and generation | Embedding outages now hit a circuit too (before, it was outside and never opened) |
| Set TRUST_PROXY in the deployment + same calculation for sockets | Everyone collapsing into one IP became actual per-IP |
| Reject socket origins in allowRequest | The websocket-pinned bypass is closed (the cors option alone didn't block it) |
| Origin check on state-changing requests | The preflight-free CSRF path is closed |
| fields and parts limits on multer | One request that pushed memory 130 → 300MB now gets an immediate 400 |
| Nickname split from the authorization identity | Typing someone else's name to delete their room and images is closed |
| Graceful degradation on failure | Sources returned even with the LLM dead, error rate 0 |
| Question embedding cache | Repeated questions 1197ms → 0.05ms |
| Log writes moved to the background | p99 2794 → 1606ms (-42%) |
| Injecting the clock in tests | Deterministic without waiting; layer behavior pinned by 109 tests |
