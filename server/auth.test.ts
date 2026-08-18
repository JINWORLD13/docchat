// 비밀번호 검증과 쿠키 파싱 단위 테스트.
//
// 이 파일이 늦게 생긴 대가를 한 번 치렀다. 서버의 다른 모듈에는 전부 .test.ts가
// 있는데 auth.ts만 없었고, 그 사이에 "없는 아이디로 로그인하면 401이 아니라
// 500이 나가는" 버그가 들어와 있었다. 상수 시간 비교(timingSafeEqual)는 길이가
// 다르면 false가 아니라 예외를 던지는데, 시간을 맞추려고 넣어둔 더미 해시가
// 짧아서 매번 그 예외를 밟고 있었다.
//
// 아픈 점은 그게 단순한 500이 아니라는 것이다. 있는 아이디는 401, 없는 아이디는
// 500이 나가므로, 응답 시간을 맞추려고 넣은 코드가 정작 상태 코드로 "그 계정이
// 있다"를 알려주고 있었다 — 막으려던 것보다 훨씬 굵은 신호로.
//
// 그래서 여기서 고정하는 것은 "맞는 비번이 통과한다"가 아니라 그 반대다:
// 검증이 어떤 입력에도 예외로 빠져나가지 않고 반드시 참/거짓으로 답한다는 것.

import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  requireLogin,
  tokenFromCookieHeader,
  verifyPassword,
} from "./auth.ts";

test("맞는 비밀번호는 통과하고 틀린 비밀번호는 막는다", () => {
  const stored = hashPassword("correct-horse-battery");
  assert.equal(verifyPassword("correct-horse-battery", stored), true);
  assert.equal(verifyPassword("correct-horse-batterz", stored), false);
});

test("같은 비밀번호라도 저장된 해시는 매번 다르다 (소금)", () => {
  // 무지개표 공격을 무력화하는 근거. 둘 다 각자의 소금으로 검증되어야 한다.
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-password", a), true);
  assert.equal(verifyPassword("same-password", b), true);
});

test("게스트 계정(빈 해시)은 어떤 비밀번호로도 로그인되지 않는다", () => {
  // schema.sql: 게스트의 password_hash는 빈 문자열이다.
  assert.equal(verifyPassword("", ""), false);
  assert.equal(verifyPassword("아무거나", ""), false);
});

test("해시 모양이 아닌 값에도 예외 없이 거짓을 준다 (401이 500이 되지 않게)", () => {
  // 여기가 회귀 지점이다. 예전에는 길이가 안 맞는 값에서 timingSafeEqual이
  // RangeError를 던졌고, 그게 라우트를 뚫고 나가 500이 됐다.
  // 검증 함수는 무엇을 받든 참/거짓으로만 답해야 한다.
  for (const broken of [
    "0f:00", // 예전에 로그인 라우트가 쓰던 더미 — 이것 때문에 터졌다
    "salt:tooshort",
    "소금만있음",
    ":",
    ":hash",
    "salt:",
    "a:b:c",
  ]) {
    assert.equal(
      verifyPassword("아무 비밀번호", broken),
      false,
      `${JSON.stringify(broken)}에서 예외가 나거나 참이 되면 안 된다`
    );
  }
});

test("더미 해시는 진짜 해시와 모양이 같다 (검증 경로가 갈리지 않게)", () => {
  // 없는 아이디의 응답 시간을 맞추려면 더미도 진짜와 같은 길을 지나야 한다.
  // 모양이 다르면 앞의 검사에 먼저 걸려 scrypt를 건너뛰고, 그 차이가 곧
  // "그 아이디는 없다"는 신호가 된다.
  const real = hashPassword("무엇이든");
  const [realSalt, realHash] = real.split(":");
  const [dummySalt, dummyHash] = DUMMY_PASSWORD_HASH.split(":");

  assert.ok(realSalt && realHash && dummySalt && dummyHash);
  assert.equal(dummyHash.length, realHash.length, "hex 길이가 같아야 한다");
  assert.ok(dummySalt.length > 0, "소금이 비어 있으면 모양 검사에서 먼저 걸린다");

  // 그러면서도 어떤 비밀번호와도 맞지 않아야 한다.
  assert.equal(verifyPassword("", DUMMY_PASSWORD_HASH), false);
  assert.equal(verifyPassword("guess", DUMMY_PASSWORD_HASH), false);
});

test("쿠키 헤더에서 세션 토큰만 꺼낸다", () => {
  assert.equal(tokenFromCookieHeader("sid=abc123"), "abc123");
  assert.equal(tokenFromCookieHeader("other=1; sid=abc123; more=2"), "abc123");
  assert.equal(tokenFromCookieHeader(" sid = abc123 "), "abc123", "공백은 무시한다");
});

test("쿠키가 없거나 이상해도 터지지 않는다", () => {
  // 이 값은 신뢰 경계 밖에서 온다. 여기서 예외가 나면 소켓 핸드셰이크
  // (gateway.ts의 io.use)와 모든 인증 요청이 함께 무너진다.
  assert.equal(tokenFromCookieHeader(undefined), null);
  assert.equal(tokenFromCookieHeader(""), null);
  assert.equal(tokenFromCookieHeader("나는쿠키가아니다"), null);
  assert.equal(tokenFromCookieHeader("sidx=abc"), null, "이름이 다르면 안 된다");
  assert.equal(tokenFromCookieHeader("xsid=abc"), null, "이름이 다르면 안 된다");
});

// --- 로그인 문 (requireLogin) ---
//
// 질문·문서·이미지 경로가 이 문 뒤로 들어갔다(index.ts, routes/images.ts).
// 여기서 고정하는 건 두 가지다.
//   1) 세션이 없으면 반드시 401이다. 프런트가 그 코드 하나로 "로그인 화면으로
//      돌아가라"를 판단하므로(web/src/api.ts), 다른 코드가 나가면 사용자는
//      원인을 알 수 없는 오류 문구 앞에 갇힌다.
//   2) 통과시키지 않을 때는 next()를 부르지 않는다. 부르면 뒤의 라우터가
//      그대로 실행돼서, 문을 세워둔 의미가 사라진다.
//
// 아래 경우들은 전부 DB를 보지 않고 판정된다(쿠키가 없거나 토큰 모양이 아니다).
// 그래서 이 테스트는 서버의 다른 테스트와 마찬가지로 DB 없이 CI에서 돈다.

interface GateResult {
  status: number | null;
  body: unknown;
  passed: boolean; // next()가 불렸나 (= 뒤 라우터로 넘어갔나)
  error: unknown; // next(err)로 넘어온 값
}

function passThroughGate(cookie: string | undefined): Promise<GateResult> {
  return new Promise((resolve) => {
    const result: GateResult = { status: null, body: undefined, passed: false, error: undefined };
    const res = {
      status(code: number) {
        result.status = code;
        return res;
      },
      json(payload: unknown) {
        result.body = payload;
        resolve(result);
        return res;
      },
    };
    const next = (err?: unknown) => {
      result.passed = err === undefined;
      result.error = err;
      resolve(result);
    };
    requireLogin(
      { headers: cookie === undefined ? {} : { cookie } } as Request,
      res as unknown as Response,
      next
    );
  });
}

test("쿠키가 없으면 401로 막고 뒤 라우터로 넘기지 않는다", async () => {
  const r = await passThroughGate(undefined);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: "로그인이 필요해요." });
  assert.equal(r.passed, false, "막았는데 next()를 부르면 라우터가 그대로 돈다");
});

test("세션 쿠키가 아닌 쿠키만 있으면 막는다", async () => {
  const r = await passThroughGate("theme=dark; lang=ko");
  assert.equal(r.status, 401);
  assert.equal(r.passed, false);
});

test("토큰 모양이 아니면 DB까지 가지 않고 막는다", async () => {
  // 세션 토큰은 64자리 hex다(auth.ts). 모양부터 걸러야, 아무 문자열이나
  // 쿠키에 넣어 쏘는 것만으로 요청당 세션 조회 한 번씩을 강제할 수 없다.
  for (const bogus of ["sid=", "sid=아무거나", "sid=deadbeef", `sid=${"z".repeat(64)}`]) {
    const r = await passThroughGate(bogus);
    assert.equal(r.status, 401, `${bogus}는 막혀야 한다`);
    assert.equal(r.passed, false);
    assert.equal(r.error, undefined, "DB에 갔다면 연결 오류가 next로 올라왔을 것이다");
  }
});
