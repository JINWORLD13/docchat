import { Router } from "express";
import multer from "multer";
// 문서 업로드·수정·삭제·조회는 쓰기 풀(관리 경로). 질문 검색용 읽기 풀과 격리한다.
import { writePool as pool } from "../db.js";
import { chunkText } from "../chunk.js";
import { embedTexts } from "../gemini.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
});

const MAX_CHUNKS = 300;
const EMBED_BATCH = 10;

// 원문 텍스트를 청크로 나누고 각 청크를 임베딩한다.
// 업로드와 수정이 같은 과정을 거치므로 함수로 묶었다.
// 무료 티어 rate limit 때문에 임베딩은 한 번에 몰지 않고 배치로 나눠 보낸다.
async function chunkAndEmbed(text) {
  const chunks = chunkText(text);
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    embeddings.push(...(await embedTexts(chunks.slice(i, i + EMBED_BATCH))));
  }
  return { chunks, embeddings };
}

async function insertChunks(client, docId, chunks, embeddings) {
  for (let i = 0; i < chunks.length; i++) {
    await client.query(
      `insert into chunks (document_id, chunk_index, content, embedding)
       values ($1, $2, $3, $4)`,
      [docId, i, chunks[i], JSON.stringify(embeddings[i])]
    );
  }
}

router.get("/", async (req, res) => {
  const { rows } = await pool.query(
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
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "잘못된 문서 id입니다." });
  }
  const { rows } = await pool.query(
    "select id, filename, content from documents where id = $1",
    [id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: "문서를 찾을 수 없습니다." });
  }
  res.json(rows[0]);
});

router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "파일이 없습니다." });
  }

  // multer는 파일명을 latin1로 해석해서 한글 파일명이 깨진다. utf8로 되돌려준다.
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");

  if (!/\.(txt|md)$/i.test(filename)) {
    return res.status(400).json({ error: "txt, md 파일만 업로드할 수 있습니다." });
  }

  const text = req.file.buffer.toString("utf8");
  if (!text.trim()) {
    return res.status(400).json({ error: "문서 내용이 비어 있습니다." });
  }

  try {
    const { chunks, embeddings } = await chunkAndEmbed(text);
    if (chunks.length > MAX_CHUNKS) {
      return res.status(400).json({ error: "문서가 너무 큽니다. 나눠서 업로드해주세요." });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const docResult = await client.query(
        "insert into documents (filename, content) values ($1, $2) returning id",
        [filename, text]
      );
      const docId = docResult.rows[0].id;
      await insertChunks(client, docId, chunks, embeddings);
      await client.query("commit");
      res.json({ id: docId, filename, chunkCount: chunks.length });
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
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "잘못된 문서 id입니다." });
  }
  const text = (req.body?.content || "").trim();
  if (!text) {
    return res.status(400).json({ error: "문서 내용이 비어 있습니다." });
  }

  try {
    const { chunks, embeddings } = await chunkAndEmbed(text);
    if (chunks.length > MAX_CHUNKS) {
      return res.status(400).json({ error: "문서가 너무 큽니다." });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        "update documents set content = $1 where id = $2 returning id",
        [text, id]
      );
      if (updated.rows.length === 0) {
        await client.query("rollback");
        return res.status(404).json({ error: "문서를 찾을 수 없습니다." });
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

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "잘못된 문서 id입니다." });
  }
  // chunks는 on delete cascade로 함께 지워진다
  await pool.query("delete from documents where id = $1", [id]);
  res.json({ ok: true });
});

export default router;
