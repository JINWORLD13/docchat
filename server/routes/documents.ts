import { Router } from "express";
import multer from "multer";
import type pg from "pg";
// 문서 업로드·수정·삭제·조회는 쓰기 풀(관리 경로). 질문 검색용 읽기 풀과 격리한다.
import { writePool as pool } from "../db.ts";
import { chunkText } from "../chunk.ts";
import { embedTexts } from "../gemini.ts";
import { requireWriteAccess } from "../admin.ts";

const router = Router();
// fileSize 말고도 상한을 준다. 이유는 routes/images.ts에 적어둔 것과 같다 —
// multer는 나머지를 busboy 기본값(fields: Infinity)으로 두므로, 파일 없이
// 텍스트 필드만 잔뜩 담은 요청이 우리 코드에 닿기도 전에 메모리를 채운다.
// 이 라우터는 requireWriteAccess 뒤에 있어 노출은 덜하지만, 같은 실수를
// 두 곳에 남겨둘 이유가 없다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 2, parts: 4, fieldSize: 100 },
});

const MAX_CHUNKS = 300;
const EMBED_BATCH = 10;

// id는 serial(int4) 컬럼이다. Number.isInteger만 보면 99999999999도 통과해서
// Postgres가 범위 초과로 거절하고, 그게 500으로 잡힌다 — 클라이언트 실수가
// 서버 에러율에 섞이는 것을 막자는 index.ts의 기준과 어긋난다.
// raw를 unknown으로 받는 이유: 미들웨어가 붙은 라우트에서는 Express가
// req.params.id를 string[]까지 포함한 타입으로 넓혀서 준다. 어차피 숫자로
// 바꿔 검사할 값이라, 좁히는 책임을 이 함수 안에 둔다.
const MAX_INT4 = 2147483647;
function validId(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_INT4) return null;
  return id;
}

type DocumentSummary = {
  id: number;
  filename: string;
  uploaded_at: Date;
  chunk_count: number;
};

type DocumentDetail = {
  id: number;
  filename: string;
  content: string;
};

// "너무 큼"과 "성공"을 유니온으로 갈라놓는다.
// 예전엔 { tooLarge: true, chunks, embeddings: [] }처럼 한 모양에 다 담았는데,
// 그러면 실패한 경우에도 빈 chunks/embeddings를 읽을 수 있어 실수하기 쉽다.
// 이렇게 두면 tooLarge를 확인하기 전에는 chunks에 접근조차 안 된다.
type EmbedResult =
  | { tooLarge: true }
  | { tooLarge: false; chunks: string[]; embeddings: number[][] };

// 원문 텍스트를 청크로 나누고 각 청크를 임베딩한다.
// 업로드와 수정이 같은 과정을 거치므로 함수로 묶었다.
// 크기 상한 검사는 임베딩 전에 한다 — 초과 문서를 전부 임베딩하고 나서
// 버리면 API 호출(무료 티어 rate limit 포함)만 낭비하기 때문.
// 무료 티어 rate limit 때문에 임베딩은 한 번에 몰지 않고 배치로 나눠 보낸다.
async function chunkAndEmbed(text: string): Promise<EmbedResult> {
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) return { tooLarge: true };

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    embeddings.push(...(await embedTexts(chunks.slice(i, i + EMBED_BATCH))));
  }
  return { tooLarge: false, chunks, embeddings };
}

async function insertChunks(
  client: pg.PoolClient,
  docId: number,
  chunks: string[],
  embeddings: number[][]
): Promise<void> {
  for (const [i, content] of chunks.entries()) {
    const embedding = embeddings[i];
    // 청크 수와 임베딩 수가 어긋나면 조용히 빈 값을 넣지 말고 트랜잭션을 깨뜨린다.
    // (rollback 되므로 반쯤 저장된 문서가 남지 않는다)
    if (!embedding) throw new Error(`청크 ${i}의 임베딩이 없습니다.`);
    await client.query(
      `insert into chunks (document_id, chunk_index, content, embedding)
       values ($1, $2, $3, $4)`,
      [docId, i, content, JSON.stringify(embedding)]
    );
  }
}

router.get("/", async (_req, res) => {
  const { rows } = await pool.query<DocumentSummary>(
    `select d.id, d.filename, d.uploaded_at, count(c.id)::int as chunk_count
       from documents d
       left join chunks c on c.document_id = d.id
      group by d.id
      order by d.id desc`
  );
  res.json(rows);
});

// 문서 한 개의 원문을 반환한다 (열람/수정 팝업에서 사용)
router.get("/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "잘못된 문서 id입니다." });
    return;
  }
  const { rows } = await pool.query<DocumentDetail>(
    "select id, filename, content from documents where id = $1",
    [id]
  );
  const doc = rows[0];
  if (!doc) {
    res.status(404).json({ error: "문서를 찾을 수 없습니다." });
    return;
  }
  res.json(doc);
});

router.post("/", requireWriteAccess, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "파일이 없습니다." });
    return;
  }

  // multer는 파일명을 latin1로 해석해서 한글 파일명이 깨진다. utf8로 되돌려준다.
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");

  if (!/\.(txt|md)$/i.test(filename)) {
    res.status(400).json({ error: "txt, md 파일만 업로드할 수 있습니다." });
    return;
  }

  const text = req.file.buffer.toString("utf8");
  if (!text.trim()) {
    res.status(400).json({ error: "문서 내용이 비어 있습니다." });
    return;
  }

  try {
    const embedded = await chunkAndEmbed(text);
    if (embedded.tooLarge) {
      res.status(400).json({ error: "문서가 너무 큽니다. 나눠서 업로드해주세요." });
      return;
    }
    const { chunks, embeddings } = embedded;

    const client = await pool.connect();
    try {
      await client.query("begin");
      const docResult = await client.query<{ id: number }>(
        "insert into documents (filename, content) values ($1, $2) returning id",
        [filename, text]
      );
      const inserted = docResult.rows[0];
      if (!inserted) throw new Error("문서 insert가 id를 돌려주지 않았습니다.");
      await insertChunks(client, inserted.id, chunks, embeddings);
      await client.query("commit");
      res.json({ id: inserted.id, filename, chunkCount: chunks.length });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("upload error:", e);
    res.status(500).json({ error: "업로드 처리 중 오류가 발생했습니다." });
  }
});

// 원문을 수정하면 청크와 임베딩을 다시 만들어 통째로 교체한다.
router.put("/:id", requireWriteAccess, async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "잘못된 문서 id입니다." });
    return;
  }
  const text = String(req.body?.content ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "문서 내용이 비어 있습니다." });
    return;
  }

  try {
    const embedded = await chunkAndEmbed(text);
    if (embedded.tooLarge) {
      res.status(400).json({ error: "문서가 너무 큽니다." });
      return;
    }
    const { chunks, embeddings } = embedded;

    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<{ id: number }>(
        "update documents set content = $1 where id = $2 returning id",
        [text, id]
      );
      if (updated.rows.length === 0) {
        await client.query("rollback");
        res.status(404).json({ error: "문서를 찾을 수 없습니다." });
        return;
      }
      await client.query("delete from chunks where document_id = $1", [id]);
      await insertChunks(client, id, chunks, embeddings);
      await client.query("commit");
      res.json({ id, chunkCount: chunks.length });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("update error:", e);
    res.status(500).json({ error: "수정 처리 중 오류가 발생했습니다." });
  }
});

router.delete("/:id", requireWriteAccess, async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "잘못된 문서 id입니다." });
    return;
  }
  // chunks는 on delete cascade로 함께 지워진다
  await pool.query("delete from documents where id = $1", [id]);
  res.json({ ok: true });
});

export default router;
