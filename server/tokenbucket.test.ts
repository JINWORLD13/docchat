// Token Bucket 알고리즘 자체의 단위 테스트.
//
// take()가 시각(now)을 인자로 받게 만들어둔 덕분에, 충전을 확인할 때
// 실제로 기다릴 필요가 없다. sleep에 기대는 테스트는 느린 데다 CI에서
// 간헐적으로 깨지는데(타이밍이 빠듯하면 실패), 시각을 넣어주면 결정적이다.

import test from "node:test";
import assert from "node:assert/strict";
import { TokenBuckets } from "./tokenbucket.ts";

const T0 = 1_700_000_000_000; // 기준 시각 (아무 값이나 고정이면 된다)

test("용량만큼은 즉시 통과하고, 초과분은 거절한다", () => {
  const buckets = new TokenBuckets(3, 5);

  assert.equal(buckets.take("a", T0).ok, true);
  assert.equal(buckets.take("a", T0).ok, true);
  assert.equal(buckets.take("a", T0).ok, true);
  assert.equal(buckets.take("a", T0).ok, false, "용량 3을 넘으면 거절");
});

test("거절할 때 얼마나 기다리면 되는지 알려준다", () => {
  const buckets = new TokenBuckets(1, 5); // 초당 5개 → 1개 차는 데 200ms
  buckets.take("a", T0);

  const result = buckets.take("a", T0);
  assert.equal(result.ok, false);
  // ok가 false로 좁혀졌으므로 여기서만 retryAfterSec에 접근할 수 있다.
  assert.ok(result.ok === false && result.retryAfterSec >= 1);
});

test("시간이 지나면 토큰이 충전된다", () => {
  const buckets = new TokenBuckets(2, 5); // 초당 5개 → 200ms에 1개
  buckets.take("a", T0);
  buckets.take("a", T0);
  assert.equal(buckets.take("a", T0).ok, false, "소진 직후엔 막힌다");

  assert.equal(buckets.take("a", T0 + 200).ok, true, "200ms 뒤 1개 충전");
});

test("충전은 용량을 넘지 않는다", () => {
  const buckets = new TokenBuckets(2, 5);
  buckets.take("a", T0);

  // 한참(10초) 뒤 = 50개가 찰 시간이지만 용량은 2다.
  assert.equal(buckets.take("a", T0 + 10_000).ok, true);
  assert.equal(buckets.take("a", T0 + 10_000).ok, true);
  assert.equal(buckets.take("a", T0 + 10_000).ok, false, "쌓아두고 몰아 쓸 수는 없다");
});

test("버킷은 키별로 따로 관리된다 (한 명의 폭주가 남을 막지 않는다)", () => {
  const buckets = new TokenBuckets(1, 5);
  buckets.take("a", T0);
  assert.equal(buckets.take("a", T0).ok, false, "a는 소진");

  assert.equal(buckets.take("b", T0).ok, true, "b는 영향받지 않는다");
});

test("거절 수와 버킷 수를 관측용으로 집계한다", () => {
  const buckets = new TokenBuckets(1, 5);
  buckets.take("a", T0);
  buckets.take("a", T0); // 거절
  buckets.take("b", T0);

  const stats = buckets.stats();
  assert.equal(stats.rejected, 1);
  assert.equal(stats.buckets, 2);
  assert.equal(stats.capacity, 1);
});

test("drop은 해당 키를 즉시 회수한다 (소켓 연결 종료)", () => {
  const buckets = new TokenBuckets(1, 5);
  buckets.take("socket-1", T0);
  assert.equal(buckets.stats().buckets, 1);

  buckets.drop("socket-1");
  assert.equal(buckets.stats().buckets, 0);
});

test("sweep은 유휴 버킷만 회수한다 (IP처럼 종료 신호가 없는 키)", () => {
  const buckets = new TokenBuckets(5, 5);
  buckets.take("old", T0);
  buckets.take("recent", T0 + 9_000);

  buckets.sweep(5_000, T0 + 10_000); // 5초 넘게 안 쓴 것만 제거

  assert.equal(buckets.stats().buckets, 1, "오래된 것만 사라진다");
  assert.equal(buckets.take("recent", T0 + 10_000).ok, true, "최근 버킷은 상태가 유지된다");
});
