import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import multer from "multer";
import { sniffImage } from "../imagetype.ts";
import { saveImage, loadImage } from "../images.ts";
import { TokenBuckets } from "../tokenbucket.ts";
import { requireLogin } from "../auth.ts";

const router = Router();

// 2MB. 문서(1MB)보다 넉넉한 이유는 사진 한 장이 원래 그보다 크기 때문이고,
// 더 키우지 않는 이유는 이 바이트가 그대로 DB row로 들어가기 때문이다.
const MAX_BYTES = 2 * 1024 * 1024;

// 파일 크기만 막는 것으로는 부족하다.
//
// multer에 fileSize와 files만 주면 나머지는 busboy 기본값이 되는데, 그 기본값은
// fields: Infinity다. 즉 파일 없이 텍스트 필드만 40만 개 담은 요청을 보내면
// 우리가 손대기도 전에 전부 메모리에 쌓인다 — 실제로 47MB 요청 하나에 프로세스
// 메모리가 130MB에서 300MB로 뛰었고, 넷을 동시에 보내면 550MB였다.
// 무료 티어 상한이 512MB라 그대로 죽는다. 그러면 같은 프로세스에 얹힌 실시간
// 채팅도 함께 끊긴다(db.ts에서 풀을 나눠 지키려던 것이 프로세스째 날아간다).
//
// 우리가 실제로 쓰는 건 이미지 1개와 width·height 두 필드뿐이다. 쓰는 만큼만 연다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
    fields: 4, // width, height + 여유
    parts: 6, // 파일 1 + 필드 4 + 여유
    fieldSize: 32, // 숫자 몇 자리면 충분하다
    fieldNameSize: 50,
  },
});

// 업로드 전용 제한. /api/chat의 질문 제한(10/5)과 따로 두는 이유는
// 성격이 달라서다 — 사람이 사진을 초당 몇 장씩 올릴 일은 없고, 한 건이
// 질문보다 훨씬 무겁다(수 MB가 DB로 들어간다). 그래서 더 좁게 잡는다.
const uploadBuckets = new TokenBuckets(
  Number(process.env.IMG_RL_CAPACITY || 5), // 순간 5장까지
  Number(process.env.IMG_RL_REFILL || 0.5) // 2초에 1장씩 회복
);

// 유휴 버킷 회수. 키가 IP라 "이제 안 온다"는 신호가 없으므로,
// 지우지 않으면 한 번이라도 업로드한 IP가 전부 영구히 남는다
// (ratelimit.ts와 같은 이유·같은 방식).
const IDLE_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  uploadBuckets.sweep(IDLE_MS);
  viewBuckets.sweep(IDLE_MS);
}, 60 * 1000);
sweeper.unref();

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

// 조회 쪽 제한.
//
// 업로드만 막고 조회를 열어두면 격리(Bulkhead)가 헛돈다. mediaPool은 max가 4라
// 상한을 못박은 풀인데, 조회에 제한이 없으면 동시 요청 몇백 건으로 그 4개를
// 계속 점유할 수 있고 그러면 방 전체의 사진이 한꺼번에 안 뜬다. 캐시 헤더가
// 정상 사용자를 막아주지만, 캐시를 무시하는 쪽은 그대로 통과한다.
// 정상 사용(방 하나에 사진 수십 장)은 넉넉히 통과하도록 크게 잡는다.
const viewBuckets = new TokenBuckets(
  Number(process.env.IMG_VIEW_CAPACITY || 120),
  Number(process.env.IMG_VIEW_REFILL || 20)
);

const limitViews: RequestHandler = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const result = viewBuckets.take(ip);
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: "이미지를 너무 빨리 불러오고 있어요." });
    return;
  }
  next();
};

// id는 URL에 그대로 들어오는 값이라 모양부터 확인한다.
// 이걸 통과한 값만 쿼리로 넘어간다(파라미터 바인딩이 있어도 습관을 둔다).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- 업로드 ---
// limitUploads(메모리) → requireLogin(세션, DB일 수 있음) → multer(바이트 수신) 순서.
// 로그인을 multer 앞에 두는 게 핵심이다. 뒤에 두면 거절할 요청의 2MB를 이미 다
// 받아 메모리에 올린 뒤에야 401을 내게 된다.
router.post("/", limitUploads, requireLogin, upload.single("image"), async (req, res) => {
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
// 조회도 로그인을 요구한다. uuid라 주소를 추측할 수는 없지만, 추측 불가와
// 비공개는 다르다 — 주소는 방 전체에 브로드캐스트되고 새 탭으로 열리고
// 복사돼 나간다. "보낸 것 취소"가 바이트까지 지우는 이유(images.ts)와 같은
// 기준이다: 한 번 새어나간 주소가 영원한 열람권이 되면 안 된다.
router.get("/:id", limitViews, requireLogin, async (req, res) => {
  // 미들웨어가 붙으면서 Express가 params를 넓은 타입으로 주므로 여기서 좁힌다.
  const id = typeof req.params.id === "string" ? req.params.id : "";
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
  //
  // public이 아니라 private인 이유: 이 응답은 이제 로그인해야 받을 수 있다.
  // public은 "중간 캐시(프록시·CDN)가 저장했다가 아무에게나 다시 줘도 된다"는
  // 뜻이라, 그대로 두면 방금 세운 문을 캐시가 우회시켜 준다 — 로그인 검사를
  // 통과한 한 사람이 받아온 사진이 캐시에 남아 로그인 없는 요청에 나간다.
  // 브라우저 자기 캐시에는 그대로 남으므로 위의 성능 설계는 유지된다.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

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
