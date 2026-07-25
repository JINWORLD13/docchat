// 브라우저에서 이 서버를 부를 수 있는 오리진 목록.
//
// HTTP(index.ts)와 WebSocket(realtime/gateway.ts) 두 곳이 쓴다. 한 곳에 두는
// 이유는 어긋나면 조용히 뚫리기 때문이다 — 실제로 HTTP만 잠그고 소켓은
// origin: "*" 로 열어둔 적이 있었고, 그러면 아무 사이트나 채팅 서버에 붙어
// 방 목록을 받아보고 메시지를 보낼 수 있다. 문을 하나만 잠근 셈이었다.
//
// 기본값은 로컬 개발용 Vite 주소다. 배포할 때 CORS_ORIGINS로 실제 주소를 준다.

export const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// origin이 없는 요청(curl, 서버 간 호출, 같은 오리진)은 브라우저가 건 것이
// 아니므로 CORS의 보호 대상이 아니다. 그대로 통과시킨다.
export function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}
