// 브라우저에서 이 서버를 부를 수 있는 오리진 판정.
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

// 요청의 Origin이 우리 자신인가.
//
// 이 검사가 없으면 배포가 깨진다. 이 서버는 프런트 빌드 결과를 같은 오리진에서
// 서빙하므로(index.ts의 express.static), 배포 환경에서 브라우저가 보내는 Origin은
// 자기 자신의 주소다. 그런데 CORS_ORIGINS 기본값은 localhost:5173이라, 목록만
// 보고 판단하면 정작 우리 화면에서 나가는 요청이 거절된다.
// 그래서 "허용 목록에 있거나, 우리 자신이거나"로 판정한다.
function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // Origin이 URL로 파싱조차 안 되면 브라우저가 만든 값이 아니다. 거절 쪽으로.
    return false;
  }
}

function hostnameOf(value: string): string | null {
  try {
    // Host 헤더에는 스킴이 없어서 URL이 그냥은 못 읽는다. 붙여준다.
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// 로컬끼리의 요청인가.
//
// 이걸 왜 따로 두냐면, 개발 중에 포트가 고정이 아니기 때문이다. Vite는 5173이
// 이미 쓰이고 있으면 5174, 5175로 알아서 옮겨간다. 허용 목록(기본 5173)만 보고
// 판단하면 그 순간부터 업로드·수정·삭제가 전부 403이 된다 — 실제로 그렇게 됐고,
// 원인이 "포트가 하나 밀렸다"라서 알아내기도 어렵다.
//
// 배포에서는 열리지 않는다. 우리 쪽 Host가 실제 도메인이라 loopback이 아니고,
// 조건이 "요청을 받은 쪽도 로컬이고 보낸 쪽도 로컬일 때"이기 때문이다.
// 즉 이 완화는 "내 컴퓨터 안에서 오간 요청"에만 적용된다.
function isLocalToLocal(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  const from = hostnameOf(origin);
  const to = hostnameOf(host);
  return from !== null && to !== null && LOOPBACK.has(from) && LOOPBACK.has(to);
}

// origin이 없는 요청(curl, 서버 간 호출, 일부 same-origin GET)은 브라우저가
// 건 것이 아니므로 CORS의 보호 대상이 아니다. 그대로 통과시킨다.
//
// host를 함께 받는 이유는 위 두 함수 때문이다. HTTP는 Host 헤더,
// 소켓은 handshake.headers.host를 넘긴다.
export function isAllowedOrigin(origin: string | undefined, host?: string): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (isSameOrigin(origin, host)) return true;
  return isLocalToLocal(origin, host);
}
