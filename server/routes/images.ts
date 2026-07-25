import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import multer from "multer";
import { sniffImage } from "../imagetype.ts";
import { saveImage, loadImage } from "../images.ts";
import { TokenBuckets } from "../tokenbucket.ts";

const router = Router();

// 2MB. 문서(1MB)보다 넉넉한 이유는 사진 한 장이 원래 그보다 크기 때문이고,
// 더 키우지 않는 이유는 이 바이트가 그대로 DB row로 들어가기 때문이다.
const MAX_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

// 업로드 전용 제한. /api/chat의 질문 제한(10/5)과 따로 두는 이유는
// 성격이 달라서다 — 사람이 사진을 초당 몇 장씩 올릴 일은 없고, 한 건이
// 질문보다 훨씬 무겁다(수 MB가 DB로 들어간다). 그래서 더 좁게 잡는다.
const uploadBuckets = new TokenBuckets(
  Number(process.env.IMG_RL_CAPACITY || 5), // 순간 5장까지
  Number(process.env.IMG_RL_REFILL || 0.5) // 2초에 1장씩 회복
);

const limitUploads: RequestHandler = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const result = uploadBuckets.take(ip);
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: "이미지를 너무 빨리 올리고 있어요. 잠시 후 다시 시도해주세요." });
    return;
  }
  next();
};

// id는 URL에 그대로 들어오는 값이라 모양부터 확인한다.
// 이걸 통과한 값만 쿼리로 넘어간다(파라미터 바인딩이 있어도 습관을 둔다).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- 업로드 ---
router.post("/", limitUploads, upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "이미지가 없습니다." });
    return;
  }

  // 파일명도 Content-Type도 보지 않는다. 실제 바이트만 본다 (imagetype.ts 참고).
  const kind = sniffImage(req.file.buffer);
  if (!kind) {
    res.status(400).json({ error: "png, jpg, gif, webp 이미지만 올릴 수 있습니다." });
    return;
  }

  try {
    const id = await saveImage(req.file.buffer, kind.mime, req.body?.width, req.body?.height);
    // URL은 안 돌려준다. 클라이언트가 URL을 들고 있으면 그걸 소켓으로 되돌려
    // 보낼 수 있고, 그러면 남의 주소를 방 전체에 뿌릴 길이 열린다.
    // 주소는 언제나 서버가 만든다 (realtime/gateway.ts).
    res.json({ id });
  } catch (e) {
    console.error("image upload error:", e);
    res.status(500).json({ error: "이미지 업로드 중 오류가 발생했습니다." });
  }
});

// --- 조회 ---
router.get("/:id", async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) {
    res.status(400).json({ error: "잘못된 이미지 id입니다." });
    return;
  }

  const image = await loadImage(id);
  if (!image) {
    res.status(404).json({ error: "이미지를 찾을 수 없습니다." });
    return;
  }

  // 우리가 판별한 타입만 내려보낸다. nosniff를 같이 주는 이유는, 이게 없으면
  // 일부 브라우저가 Content-Type을 무시하고 내용을 훑어 스스로 타입을 정하는데
  // 그 과정에서 이미지가 아닌 것으로 해석돼 실행될 여지가 생기기 때문이다.
  res.setHeader("Content-Type", image.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");

  // id가 uuid고 내용이 절대 안 바뀌므로 영구 캐시로 준다.
  // 이게 이 기능의 성능 설계 전부다 — 브라우저가 한 번만 받아가면 되니까,
  // 대화가 길어져도 DB까지 오는 건 각 이미지의 첫 요청뿐이다.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  res.send(image.bytes);
});

// 이 라우터에서 난 multer 오류를 여기서 받는다.
// 전역 핸들러에 맡기면 문서 업로드용 문구("1MB 이하")가 나가서 사용자가 헷갈린다.
const handleUploadError: ErrorRequestHandler = (err, _req, res, next) => {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "이미지는 2MB 이하만 올릴 수 있습니다." });
    return;
  }
  next(err);
};
router.use(handleUploadError);

export default router;
