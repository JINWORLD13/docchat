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

// imageUrl의 반대 방향. 주소 모양을 정하는 곳이 여기니까 되읽는 짝도 여기 둔다.
// 메시지는 id가 아니라 완성된 url을 들고 있어서(그게 클라이언트에 나가는 값이다),
// 지울 때 id를 되찾아야 한다.
export function idFromUrl(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

// 보낸 사람이 취소한 이미지의 바이트를 지운다.
//
// 메시지만 지우고 행을 남기면 안 된다 — 주소를 한 번이라도 본 사람은 그대로
// 계속 볼 수 있어서, "취소했다"는 말이 사실이 아니게 된다. 보관 기간 정리
// (cleanupImages)에 맡기면 최대 24시간 뒤다.
export async function deleteImage(id: string): Promise<void> {
  await mediaPool.query("delete from chat_images where id = $1", [id]);
}

// --- 보관 기간 ---
//
// 이 테이블은 지우는 사람이 없으면 한 방향으로만 자란다. 게다가 방과 대화
// 기록은 서버 메모리에 있어서 재시작하면 사라지는데, 그때 이미지 행은 그대로
// 남아 아무도 참조하지 않는 바이트가 된다. 즉 가만히 둬도 쓰레기가 쌓인다.
//
// 업로드 제한(IMG_RL_*)이 있어도 상한이 되지 못한다. 그건 속도를 제한할 뿐
// 총량을 제한하지 않기 때문이다 — 느리게 꾸준히 올리면 영구히 쌓인다.
// 그래서 시간으로 자른다. 방 기록 자체가 최근 50개뿐인 MVP라 오래된 이미지는
// 어차피 화면에서 사라진 지 오래다.
const RETENTION_MS = Number(process.env.IMAGE_RETENTION_MS || 24 * 60 * 60 * 1000);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export async function cleanupImages(retentionMs: number = RETENTION_MS): Promise<number> {
  const { rowCount } = await mediaPool.query(
    "delete from chat_images where created_at < now() - ($1::bigint * interval '1 millisecond')",
    [retentionMs]
  );
  return rowCount ?? 0;
}

// 정리는 백그라운드로. 실패해도 서비스가 멈출 이유가 없으므로 로그만 남긴다.
// unref()라 이 타이머가 프로세스 종료를 붙잡지 않는다.
const cleaner = setInterval(() => {
  cleanupImages().catch((e: unknown) => {
    console.error("chat_images 정리 실패:", e instanceof Error ? e.message : e);
  });
}, CLEANUP_INTERVAL_MS);
cleaner.unref();
