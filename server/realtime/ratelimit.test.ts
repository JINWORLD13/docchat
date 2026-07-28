// 소켓 도배 제한 단위 테스트.
//
// 이 파일이 지키는 건 알고리즘이 아니라 "붙였다 떼는 방식으로 우회되지 않는가"다.
// 알고리즘 자체는 tokenbucket.test.ts가 본다.
//
// 여기에 테스트를 붙인 이유가 있다. 예전에 이 우회를 한 번 고쳤다고 적어뒀는데
// (키를 socket.id에서 IP로 바꾼 것), 실제로는 절반만 고쳐진 상태였다.
// 마지막 소켓이 끊길 때 버킷을 지우는 정리 코드가 남아 있어서, 혼자 접속한
// 사람은 끊는 순간 예산이 사라지고 다시 붙으면 만땅이었다.
// 문서가 "막았다"고 말하는 동작은 테스트로 고정해두지 않으면 이렇게 조용히 풀린다.

process.env.CHAT_RL_CAPACITY = "5";
process.env.CHAT_RL_REFILL = "2";
process.env.CHAT_MAX_SOCKETS_PER_IP = "3";

import test from "node:test";
import assert from "node:assert/strict";

const rl = await import("./ratelimit.ts");

// 용량만큼 보내 버킷을 비운다.
function drain(ip: string): number {
  let sent = 0;
  while (rl.allowMessage(ip)) sent++;
  return sent;
}

test("용량만큼은 통과하고 그 뒤는 막힌다", () => {
  rl.reset();
  assert.equal(drain("1.1.1.1"), 5);
  assert.equal(rl.allowMessage("1.1.1.1"), false);
});

test("끊었다 다시 붙어도 예산이 돌아오지 않는다", () => {
  rl.reset();
  const ip = "1.1.1.1";

  assert.equal(rl.addSocket(ip), true);
  drain(ip);
  assert.equal(rl.allowMessage(ip), false, "일단 막힌 상태");

  // 재연결: 끊고 다시 붙는다.
  rl.removeSocket(ip);
  assert.equal(rl.addSocket(ip), true);

  assert.equal(
    rl.allowMessage(ip),
    false,
    "제한의 수명은 연결의 수명보다 길어야 한다 — 여기가 true면 도배가 통째로 뚫린다"
  );
});

test("버킷은 IP별로 따로다 (한 명의 도배가 남을 막지 않는다)", () => {
  rl.reset();
  drain("1.1.1.1");

  assert.equal(rl.allowMessage("2.2.2.2"), true);
});

test("IP당 동시 연결 상한을 넘으면 거절한다", () => {
  rl.reset();
  const ip = "3.3.3.3";

  assert.equal(rl.addSocket(ip), true);
  assert.equal(rl.addSocket(ip), true);
  assert.equal(rl.addSocket(ip), true);
  // 상한이 없으면 연결을 여러 개 여는 것만으로 IP별 한도를 그 수만큼 곱할 수 있다.
  assert.equal(rl.addSocket(ip), false, "4번째는 거절");

  // 하나 끊으면 다시 한 자리가 난다.
  rl.removeSocket(ip);
  assert.equal(rl.addSocket(ip), true);
});

test("도배로 막힌 수를 집계한다 (대시보드용)", () => {
  rl.reset();
  drain("4.4.4.4"); // 마지막 한 번은 거절이라 여기까지가 이미 1건
  const before = rl.chatRateLimitStats().rejected;

  rl.allowMessage("4.4.4.4");
  rl.allowMessage("4.4.4.4");

  assert.equal(rl.chatRateLimitStats().rejected - before, 2);
});
