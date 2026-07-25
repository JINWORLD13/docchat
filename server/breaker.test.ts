// Circuit Breaker 단위 테스트.
// 임계치와 쿨다운은 모듈 로드 시점에 읽히므로 import 전에 정한다.
process.env.BREAKER_THRESHOLD = "3";
process.env.BREAKER_COOLDOWN_MS = "80";

import test from "node:test";
import assert from "node:assert/strict";

const breaker = await import("./breaker.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("임계치에 못 미치는 실패로는 회로가 열리지 않는다", () => {
  breaker.reset();
  breaker.onFailure();
  breaker.onFailure();

  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.breakerState().consecutiveFailures, 2);
});

test("연속 실패가 임계치에 도달하면 회로가 열린다", () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();

  assert.equal(breaker.isOpen(), true, "3번째 실패에서 열려야 한다");
  assert.ok(breaker.breakerState().reopensInMs > 0, "재시도까지 남은 시간을 알려준다");
});

test("중간에 성공하면 카운터가 리셋돼 회로가 안 열린다", () => {
  breaker.reset();
  breaker.onFailure();
  breaker.onFailure();
  breaker.onSuccess(); // 여기서 0으로
  breaker.onFailure();
  breaker.onFailure();

  assert.equal(breaker.isOpen(), false, "연속이 끊겼으니 열리면 안 된다");
  assert.equal(breaker.breakerState().consecutiveFailures, 2);
});

test("쿨다운이 지나면 회로가 닫혀 다시 시도한다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  assert.equal(breaker.isOpen(), true);

  await sleep(120); // 쿨다운 80ms보다 길게

  assert.equal(breaker.isOpen(), false, "쿨다운 뒤엔 닫혀서 재시도를 허용한다");
});

test("쿨다운 직후 한 번만 더 실패해도 즉시 다시 열린다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  await sleep(120);
  assert.equal(breaker.isOpen(), false);

  // 실패 카운터는 남아 있으므로, 탐색 요청 한 번이 실패하면 바로 재차단된다.
  // half-open 상태를 따로 두지 않고도 "아직 안 나았으면 곧바로 다시 닫는" 효과.
  breaker.onFailure();

  assert.equal(breaker.isOpen(), true, "회복 안 됐으면 곧장 다시 열려야 한다");
});

// --- 반열림(half-open) ---
//
// 쿨다운이 끝나는 순간이 함정이다. 그때 밀려 있던 요청이 한꺼번에(최대
// MAX_INFLIGHT만큼) 아직 죽어 있을지 모르는 API로 동시에 몰려간다.
// 회로를 둔 이유가 "죽은 의존성을 계속 두들기지 않는 것"인데, 복구를
// 확인하는 바로 그 순간에 정확히 그 짓을 하게 된다.

test("쿨다운 직후에는 시험 요청 하나만 통과시킨다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  await sleep(120);

  assert.equal(breaker.isOpen(), false, "첫 요청은 통과 — 복구됐는지 확인해봐야 한다");
  assert.equal(breaker.isOpen(), true, "그 결과가 나오기 전까지 나머지는 계속 막는다");
  assert.equal(breaker.isOpen(), true);
});

test("시험 요청이 성공하면 회로가 완전히 닫힌다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  await sleep(120);

  breaker.isOpen(); // 시험 요청이 나감
  breaker.onSuccess();

  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.isOpen(), false, "이제 모두 통과한다");
  assert.equal(breaker.breakerState().consecutiveFailures, 0);
});

test("상태 조회는 시험권을 소비하지 않는다", async () => {
  breaker.reset();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  await sleep(120);

  // 대시보드가 1초마다 부르는 자리. 여기서 시험권을 가져가버리면
  // 정작 실제 요청은 영영 복구를 확인할 기회를 못 얻는다.
  breaker.breakerState();
  breaker.breakerState();

  assert.equal(breaker.isOpen(), false, "시험권은 실제 요청 몫으로 남아 있어야 한다");
});

test("reset은 회로와 카운터를 모두 초기화한다", () => {
  for (let i = 0; i < 3; i++) breaker.onFailure();
  breaker.reset();

  assert.deepEqual(breaker.breakerState(), {
    open: false,
    consecutiveFailures: 0,
    reopensInMs: 0,
  });
});
