// 관리자(장애 주입) 엔드포인트 보호.
//
// 문제: /api/admin/fault 는 LLM을 고의로 실패시키는 스위치다. 로컬 데모에서는
// 편리하지만, 배포된 서버에 그대로 열려 있으면 누구나 서비스를 망가뜨릴 수 있다.
// 데모용 기능 하나가 프로덕션의 구멍이 되는 전형적인 경우다.
//
// 결정: "기본적으로 안전하게(secure by default)" 두 단계로 막는다.
// - ADMIN_TOKEN이 설정돼 있으면: 토큰이 일치해야만 통과 (배포 환경)
// - 설정돼 있지 않으면: 루프백(localhost)에서 온 요청만 통과 (로컬 데모)
// 그래서 로컬에서는 아무 설정 없이 데모가 그대로 돌고, 배포하면 토큰 없이는
// 외부에서 건드릴 수 없다. 설정을 깜빡해도 열린 채로 노출되지 않는 게 핵심이다.

import { timingSafeEqual } from "node:crypto";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 거른다.
// 비교 자체는 타이밍 공격을 막기 위해 상수 시간 비교를 쓴다.
function tokenMatches(given) {
  const a = Buffer.from(given || "", "utf8");
  const b = Buffer.from(ADMIN_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 실제 TCP 피어 주소를 본다.
// req.ip는 trust proxy가 켜져 있으면 X-Forwarded-For를 따르는데, 그 헤더는
// 클라이언트가 마음대로 넣을 수 있어 인증 판단에 쓰면 안 된다.
function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    if (!tokenMatches(req.get("x-admin-token"))) {
      return res.status(401).json({ error: "관리자 토큰이 필요합니다." });
    }
    return next();
  }

  if (!isLoopback(req)) {
    return res.status(403).json({
      error: "관리자 기능은 로컬에서만 사용할 수 있습니다. 원격에서 쓰려면 ADMIN_TOKEN을 설정하세요.",
    });
  }
  return next();
}

export function adminMode() {
  return ADMIN_TOKEN ? "token" : "loopback-only";
}
