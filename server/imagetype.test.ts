// 업로드 형식 판별 단위 테스트.
//
// 여기서 통과시키면 안 되는 걸 통과시키는 게 이 프로젝트에서 가장 비싼 실수다.
// 사용자가 올린 바이트를 나중에 같은 오리진에서 브라우저로 내려보내기 때문이다.
// 그래서 "받아야 할 걸 받는가"보다 "거절해야 할 걸 거절하는가"를 더 많이 본다.

import test from "node:test";
import assert from "node:assert/strict";
import { sniffImage } from "./imagetype.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif87 = Buffer.from("GIF87a....", "latin1");
const gif89 = Buffer.from("GIF89a....", "latin1");
// RIFF + 4바이트 크기 + WEBP
const webp = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);

test("PNG·JPEG·GIF·WebP를 알아본다", () => {
  assert.equal(sniffImage(png)?.mime, "image/png");
  assert.equal(sniffImage(jpeg)?.mime, "image/jpeg");
  assert.equal(sniffImage(gif87)?.mime, "image/gif");
  assert.equal(sniffImage(gif89)?.mime, "image/gif");
  assert.equal(sniffImage(webp)?.mime, "image/webp");
});

test("확장자는 내용에서 정한다 (클라이언트 파일명을 안 쓰려고)", () => {
  assert.equal(sniffImage(png)?.ext, "png");
  assert.equal(sniffImage(jpeg)?.ext, "jpg");
});

test("SVG는 이미지로 안 쳐준다 (스크립트가 실행돼 저장형 XSS가 된다)", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffImage(svg), null);
});

test("HTML을 이미지로 위장해도 거절한다", () => {
  const html = Buffer.from("<!doctype html><script>alert(1)</script>");
  assert.equal(sniffImage(html), null);
});

test("PDF·ZIP 같은 다른 바이너리도 거절한다", () => {
  assert.equal(sniffImage(Buffer.from("%PDF-1.7\n")), null);
  assert.equal(sniffImage(Buffer.from([0x50, 0x4b, 0x03, 0x04])), null);
});

test("빈 파일과 서명보다 짧은 파일에서 터지지 않는다", () => {
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage(Buffer.from([0x89, 0x50])), null, "PNG 서명 앞 2바이트만");
  assert.equal(sniffImage(Buffer.from("RIFF", "latin1")), null, "WEBP 표시 전에 끝난 RIFF");
});

test("RIFF지만 WebP가 아니면 거절한다 (WAV 등)", () => {
  const wav = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WAVEfmt ", "latin1"),
  ]);
  assert.equal(sniffImage(wav), null);
});

test("GIF8이지만 버전 문자가 다르면 거절한다", () => {
  assert.equal(sniffImage(Buffer.from("GIF88a....", "latin1")), null);
});
