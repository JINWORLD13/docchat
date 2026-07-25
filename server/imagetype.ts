// 업로드된 바이트가 정말 이미지인지 앞머리(magic bytes)를 보고 판별한다.
//
// 왜 확장자나 Content-Type을 안 믿나:
// 둘 다 클라이언트가 적어 보내는 값이라 얼마든지 거짓말할 수 있다.
// `evil.html`을 `cat.png`라는 이름에 `image/png` 타입으로 올릴 수 있다는 뜻이다.
// 우리는 이 파일을 나중에 브라우저에 그대로 내려보내므로, 실제 내용이 무엇인지
// 우리 눈으로 확인해야 한다. 파일 형식은 앞부분 몇 바이트에 고정된 서명이 있다.
//
// SVG를 일부러 뺐다:
// SVG는 XML이고 그 안에 <script>가 들어간다. 브라우저가 이미지로 렌더링하면서
// 그 스크립트를 실행하므로, 사용자가 올린 SVG를 같은 오리진에서 내려보내는 순간
// 저장형 XSS가 된다. 래스터 포맷만 받으면 이 문제가 통째로 사라진다.
// (magic bytes로 거르는 방식과도 잘 맞는다 — SVG는 고정 서명이 없다)

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageKind {
  mime: ImageMime;
  ext: "png" | "jpg" | "gif" | "webp";
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

// 알아본 형식을 돌려주고, 모르는 형식이면 null.
// null을 "그래도 통과"로 해석할 수 없게 타입으로 못박아, 호출부가 반드시 거절하게 한다.
export function sniffImage(buf: Buffer): ImageKind | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG: FF D8 FF (SOI 마커)
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // GIF: "GIF87a" 또는 "GIF89a"
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39)) {
    return { mime: "image/gif", ext: "gif" };
  }
  // WebP: RIFF....WEBP — 4바이트 길이를 건너뛰고 8번째부터 "WEBP"
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}
