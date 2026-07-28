// 오리진 판정 단위 테스트.
//
// 이 판정은 두 가지를 동시에 만족해야 해서 실수하기 쉽다.
//  - 남의 사이트에서 온 요청은 막아야 한다 (CSRF·소켓 무단 접속)
//  - 그런데 우리 화면도 "남"처럼 보인다. 배포에서는 프런트를 같은 오리진에서
//    서빙하므로 브라우저가 보내는 Origin은 우리 자신의 주소인데, 그 주소는
//    CORS_ORIGINS 기본값(localhost:5173)에 없다.
// 두 번째를 놓치면 검사를 켜는 순간 라이브 데모가 통째로 죽는다.

import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "./origins.ts";

test("Origin이 없으면 통과시킨다 (curl·서버 간 호출)", () => {
  // 브라우저가 만든 요청이 아니므로 CSRF의 대상이 아니다.
  assert.equal(isAllowedOrigin(undefined), true);
});

test("허용 목록에 있으면 통과", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173"), true);
});

test("우리 자신이 보낸 것이면 통과 (합쳐 배포한 경우)", () => {
  // 목록에 없어도 Host와 같으면 우리 화면이다.
  assert.equal(
    isAllowedOrigin("https://docchat.example.com", "docchat.example.com"),
    true
  );
});

test("남의 사이트는 막는다", () => {
  assert.equal(isAllowedOrigin("https://evil.example.com"), false);
  assert.equal(
    isAllowedOrigin("https://evil.example.com", "docchat.example.com"),
    false,
    "Host가 우리여도 Origin이 남이면 남의 페이지에서 온 요청이다"
  );
});

test("호스트가 비슷해 보여도 정확히 같아야 한다", () => {
  // docchat.example.com.evil.com 같은 접미사 공격을 문자열 포함으로 판정하면 뚫린다.
  assert.equal(
    isAllowedOrigin("https://docchat.example.com.evil.com", "docchat.example.com"),
    false
  );
});

test("로컬끼리는 포트가 달라도 통과 (개발 중 Vite 포트가 밀리는 경우)", () => {
  // Vite는 5173이 쓰이고 있으면 5174로 옮겨간다. 목록만 보고 판단하면
  // 그 순간부터 업로드·수정·삭제가 전부 403이 된다.
  assert.equal(isAllowedOrigin("http://localhost:5174", "localhost:4000"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999", "localhost:4000"), true);
});

test("로컬 완화는 배포에서 열리지 않는다", () => {
  // 조건이 "받는 쪽도 로컬일 때"라, Host가 실제 도메인이면 적용되지 않는다.
  assert.equal(
    isAllowedOrigin("http://localhost:5174", "docchat.example.com"),
    false,
    "배포 서버에 로컬 페이지가 쓰기 요청을 보내는 것은 막는다"
  );
});

test("URL로 파싱되지 않는 Origin은 막는다", () => {
  // 브라우저가 만든 값이 아니라는 뜻이다. 통과시킬 이유가 없다.
  assert.equal(isAllowedOrigin("not a url", "docchat.example.com"), false);
});
