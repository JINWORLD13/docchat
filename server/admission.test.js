// Admission Control 단위 테스트.
// 상한/큐/데드라인은 모듈 로드 시점에 읽히므로 import 전에 정한다.
process.env.MAX_INFLIGHT = "2";
process.env.MAX_QUEUE = "2";
process.env.MAX_QUEUE_WAIT_MS = "60";

import test from "node:test";
import assert from "node:assert/strict";

const adm = await import("./admission.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("동시 처리 상한까지는 즉시 통과한다", async () => {
  adm.reset();

  assert.equal(await adm.acquire(), true);
  assert.equal(await adm.acquire(), true);
  assert.equal(adm.admissionStats().inFlight, 2);
});

test("상한을 넘으면 큐에서 기다리다 자리가 나면 이어받는다", async () => {
  adm.reset();
  await adm.acquire();
  await adm.acquire();

  const queued = adm.acquire(); // 상한 초과 → 대기
  await sleep(10);
  assert.equal(adm.admissionStats().queued, 1, "큐에 들어가 있어야 한다");

  adm.release(); // 자리 하나 반납 → 대기자에게 양보

  assert.equal(await queued, true, "대기하던 요청이 자리를 넘겨받는다");
  // 자리를 넘겨준 것이므로 동시 처리 수는 그대로 유지된다.
  assert.equal(adm.admissionStats().inFlight, 2);
  assert.equal(adm.admissionStats().queued, 0);
});

test("큐까지 꽉 차면 기다리지 않고 즉시 거절한다 (load shedding)", async () => {
  adm.reset();
  await adm.acquire();
  await adm.acquire();

  adm.acquire(); // 큐 1
  adm.acquire(); // 큐 2 (= MAX_QUEUE)

  // 큐가 꽉 찼으므로 이건 대기 없이 바로 false여야 한다.
  assert.equal(await adm.acquire(), false);
  assert.equal(adm.admissionStats().rejected, 1);
});

test("큐에서 데드라인을 넘기면 기다리길 포기하고 거절한다", async () => {
  adm.reset();
  await adm.acquire();
  await adm.acquire();

  const started = Date.now();
  const queued = adm.acquire(); // 아무도 release하지 않는다

  assert.equal(await queued, false, "무한 대기하지 않고 포기해야 한다");

  const waited = Date.now() - started;
  assert.ok(waited >= 55, `데드라인만큼은 기다린다 (실제 ${waited}ms)`);
  assert.ok(waited < 500, `데드라인을 크게 넘기지 않는다 (실제 ${waited}ms)`);
  assert.equal(adm.admissionStats().timedOut, 1);
  assert.equal(adm.admissionStats().queued, 0, "포기한 대기자는 큐에서 빠진다");
});

test("데드라인으로 포기한 자리는 다음 요청에게 낭비 없이 넘어간다", async () => {
  adm.reset();
  await adm.acquire();
  await adm.acquire();

  const abandoned = adm.acquire(); // 타임아웃될 대기자
  assert.equal(await abandoned, false);

  // 포기한 대기자가 큐에 유령으로 남아 있으면, release가 그 유령에게 자리를
  // 넘겨주고 실제 대기자는 굶는다. 그러지 않는지 확인한다.
  const fresh = adm.acquire();
  await sleep(10);
  adm.release();

  assert.equal(await fresh, true, "살아 있는 대기자가 자리를 받아야 한다");
});

test("대기자가 없으면 release가 자리를 비운다", async () => {
  adm.reset();
  await adm.acquire();
  await adm.acquire();
  assert.equal(adm.admissionStats().inFlight, 2);

  adm.release();
  adm.release();

  assert.equal(adm.admissionStats().inFlight, 0);
});
