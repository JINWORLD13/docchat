// 채팅 이미지 저장소.
//
// 저장 위치를 바꾸는 일(DB → S3 등)이 생겨도 이 파일만 고치면 되게, DB를 아는
// 코드를 여기 가둬뒀다. 부르는 쪽(routes/images.ts, realtime/gateway.ts)은
// "id로 넣고 id로 꺼낸다"만 안다. cache.ts를 Redis로 바꿔도 gemini.ts가 안
// 바뀌게 해둔 것과 같은 방식이다.

import { randomUUID } from "node:crypto";
import { mediaPool } from "./db.ts";
import type { ImageMime } from "./imagetype.ts";

// 화면에서 자리를 잡는 용도의 힌트라 클라이언트가 잰 값을 받는다.
// 다만 그대로 믿으면 0이나 말도 안 되는 값이 들어와 레이아웃이 깨지므로 자른다.
const MAX_DIM = 8000;

function clampDimension(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_DIM);
}

export interface StoredImage {
  mime: string;
  bytes: Buffer;
  width: number;
  height: number;
}

export async function saveImage(
  bytes: Buffer,
  mime: ImageMime,
  width: unknown,
  height: unknown
): Promise<string> {
  // id를 서버가 만든다. 클라이언트가 정하게 두면 남의 id를 덮어쓸 수 있다.
  const id = randomUUID();
  await mediaPool.query(
    "insert into chat_images (id, mime, bytes, width, height) values ($1, $2, $3, $4, $5)",
    [id, mime, bytes, clampDimension(width), clampDimension(height)]
  );
  return id;
}

export async function loadImage(id: string): Promise<StoredImage | null> {
  const { rows } = await mediaPool.query<StoredImage>(
    "select mime, bytes, width, height from chat_images where id = $1",
    [id]
  );
  return rows[0] ?? null;
}

// 소켓으로 들어온 id가 우리가 발급한 것인지 확인하고, 크기까지 같이 돌려준다.
// bytes를 함께 읽지 않는 게 핵심 — 메시지를 브로드캐스트할 때마다 수백 KB를
// DB에서 끌어올 이유가 없다. 실제 바이트는 브라우저가 URL로 따로 받아간다.
export async function describeImage(
  id: string
): Promise<{ width: number; height: number } | null> {
  const { rows } = await mediaPool.query<{ width: number; height: number }>(
    "select width, height from chat_images where id = $1",
    [id]
  );
  return rows[0] ?? null;
}

// URL은 언제나 서버가 만든다 (realtime/gateway.ts 주석 참고).
export function imageUrl(id: string): string {
  return `/api/chat/image/${id}`;
}
