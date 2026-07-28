// 클라이언트 IP 판정 단위 테스트.
//
// 이 함수가 틀리면 조용히 둘 중 하나가 된다.
//  - 홉 수를 0으로 두고 프록시 뒤에 서면: 전원이 한 IP로 묶여 "IP별 제한"이
//    "전체 공용 한도"가 된다. 실제로 배포판이 그 상태였다.
//  - 홉 수를 실제보다 크게 주면: 클라이언트가 헤더에 써넣은 값을 그대로 믿게
//    되어 제한이 통째로 우회된다.
// 어느 쪽도 화면에는 안 드러나므로 테스트로 못박는다.

import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, trustedHops } from "./clientip.ts";

test("신뢰하지 않으면(기본) XFF를 아예 보지 않는다", () => {
  // 프록시가 없는데 헤더를 믿으면, 공격자가 요청마다 다른 IP인 척할 수 있다.
  assert.equal(clientIp("10.0.0.2", "1.1.1.1", 0), "10.0.0.2");
  assert.equal(clientIp("10.0.0.2", "1.1.1.1, 2.2.2.2", 0), "10.0.0.2");
});

test("한 홉을 신뢰하면 XFF의 오른쪽 끝을 클라이언트로 본다", () => {
  // Render처럼 엣지가 하나인 경우. 프록시가 붙여준 값이 그 오른쪽 끝이다.
  assert.equal(clientIp("10.0.0.2", "203.0.113.7", 1), "203.0.113.7");
});

test("두 홉이면 하나 더 왼쪽을 본다", () => {
  assert.equal(clientIp("10.0.0.3", "203.0.113.7, 10.0.0.1", 2), "203.0.113.7");
  // 같은 헤더라도 홉 수가 1이면 프록시 주소가 나온다 — 홉 수는 정확해야 한다.
  assert.equal(clientIp("10.0.0.3", "203.0.113.7, 10.0.0.1", 1), "10.0.0.1");
});

test("홉 수가 실제 체인보다 크면 우리가 아는 가장 왼쪽에서 멈춘다", () => {
  // 공격자가 XFF를 길게 늘여 "더 왼쪽"을 만들어도, 우리가 확인 가능한 범위를
  // 넘어서 더 믿어주지는 않는다.
  assert.equal(clientIp("10.0.0.2", "203.0.113.7", 5), "203.0.113.7");
});

test("XFF가 없거나 비어 있으면 실제 연결 주소를 쓴다", () => {
  assert.equal(clientIp("10.0.0.2", undefined, 1), "10.0.0.2");
  assert.equal(clientIp("10.0.0.2", "", 1), "10.0.0.2");
  assert.equal(clientIp("10.0.0.2", " , ", 1), "10.0.0.2");
});

test("헤더가 배열로 와도(중복 헤더) 처리한다", () => {
  assert.equal(clientIp("10.0.0.2", ["203.0.113.7", "10.0.0.1"], 2), "203.0.113.7");
});

test("연결 주소를 모르면 unknown", () => {
  assert.equal(clientIp(undefined, undefined, 0), "unknown");
});

test("TRUST_PROXY는 숫자가 아니면 0으로 본다 (안전한 쪽)", () => {
  assert.equal(trustedHops("1"), 1);
  assert.equal(trustedHops("2"), 2);
  assert.equal(trustedHops(undefined), 0);
  assert.equal(trustedHops("true"), 0, "설정 실수로 헤더를 믿어버리지 않는다");
  assert.equal(trustedHops("-1"), 0);
});
