// Rate Limiter 미들웨어 단위 테스트.
//
// 알고리즘(Token Bucket) 자체는 tokenbucket.test.ts에서 결정적으로 검증한다.
// 여기서 볼 건 "그걸 HTTP에 제대로 붙였는가"다 — 통과하면 next()로 넘기는지,
// 막을 때 429와 Retry-After를 주는지, IP를 키로 쓰는지.
//
// 설정은 모듈 로드 시점에 환경변수로 읽히므로, import 전에 값을 정한다.
// (node --test는 파일마다 별도 프로세스로 돌려서 파일 간 환경변수가 안 섞인다.)
process.env.RL_CAPACITY = "3";
process.env.RL_REFILL = "5"; // 초당 5개 → 200ms에 1개

import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

const { rateLimit, rateLimitStats } = await import("./ratelimit.ts");

interface FakeRes {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  setHeader(key: string, value: string): void;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = value;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

// 미들웨어를 한 번 태우고 통과 여부와 응답을 돌려준다.
// Express의 Request/Response 전체를 흉내 낼 필요는 없고 미들웨어가 실제로
// 만지는 필드만 있으면 되므로, 그 사실을 캐스팅으로 명시한다.
function hit(ip: string): { passed: boolean; res: FakeRes } {
  const res = fakeRes();
  let passed = false;
  const req = { ip, socket: { remoteAddress: ip } } as unknown as Request;
  rateLimit(req, res as unknown as Response, () => {
    passed = true;
  });
  return { passed, res };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("버킷 용량만큼 통과하고 초과분은 429로 막는다", () => {
  const results = Array.from({ length: 5 }, () => hit("10.0.0.1"));

  assert.equal(results.filter((r) => r.passed).length, 3, "용량 3만큼만 통과");
  assert.equal(results.filter((r) => !r.passed).length, 2, "나머지는 거절");

  const blocked = results.find((r) => !r.passed);
  assert.ok(blocked, "거절된 요청이 있어야 한다");
  assert.equal(blocked.res.statusCode, 429);
  // 언제 다시 오면 되는지 알려줘야 클라이언트가 재시도를 조절할 수 있다.
  assert.ok(blocked.res.headers["retry-after"], "Retry-After 헤더가 있어야 한다");
});

test("버킷은 IP별로 따로 관리된다 (한 명의 폭주가 남을 막지 않는다)", () => {
  Array.from({ length: 5 }, () => hit("10.0.0.2")); // 이쪽은 이미 소진

  assert.equal(hit("10.0.0.3").passed, true, "다른 IP는 영향받지 않는다");
});

test("시간이 지나면 토큰이 충전돼 다시 통과한다", async () => {
  Array.from({ length: 5 }, () => hit("10.0.0.4")); // 소진
  assert.equal(hit("10.0.0.4").passed, false, "소진 직후엔 막힌다");

  await sleep(300); // 초당 5개 충전 → 300ms면 1개 이상 회복

  assert.equal(hit("10.0.0.4").passed, true, "충전 뒤엔 다시 통과");
});

test("거절 수를 관측용으로 집계한다", () => {
  const before = rateLimitStats().rejected;
  Array.from({ length: 5 }, () => hit("10.0.0.5"));

  assert.equal(rateLimitStats().rejected, before + 2, "초과한 2건이 집계된다");
  assert.equal(rateLimitStats().capacity, 3);
});
