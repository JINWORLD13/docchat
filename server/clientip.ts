// 요청을 보낸 사람의 IP를 정한다.
//
// 왜 별도 파일인가: Express는 `trust proxy` 설정 하나로 req.ip를 알아서
// 계산해주지만, Socket.IO는 그 설정을 전혀 모른다. socket.handshake.address는
// engine.io가 TCP 연결의 주소(req.socket.remoteAddress)를 그대로 넘긴 값이라,
// 로드밸런서 뒤에 서면 모든 접속자가 "프록시 IP" 하나로 보인다.
//
// 그게 왜 치명적이냐면 — IP가 rate limit의 키이고, IP당 동시 소켓 상한
// (CHAT_MAX_SOCKETS_PER_IP)의 기준이기 때문이다. 전원이 같은 키를 쓰면
// "한 명의 폭주를 막는" 제한이 "전체가 나눠 쓰는 한도"로 바뀐다.
// 실제로 배포판에서 그랬다: 11번째 접속자부터 연결이 거절됐다.
//
// 그래서 Express가 하는 계산을 소켓 쪽에도 똑같이 해준다. 로직을 순수 함수로
// 떼어놓은 덕에 "홉 수를 잘못 세면 어떻게 되는가"를 테스트로 고정할 수 있다.

// 신뢰할 프록시 홉 수. index.ts의 TRUST_PROXY와 같은 값을 읽는다 —
// 두 경로가 다른 기준으로 IP를 정하면 한쪽만 뚫린다.
export function trustedHops(raw: string | undefined = process.env.TRUST_PROXY): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Express(proxy-addr)와 같은 규칙으로 클라이언트 IP를 고른다.
//
// 주소를 [실제 연결 주소, XFF의 오른쪽부터 왼쪽으로] 순서로 늘어놓고,
// 신뢰하는 홉 수만큼 건너뛴 자리를 클라이언트로 본다.
//
//   XFF: "203.0.113.7, 10.0.0.1"   remote: 10.0.0.2   hops: 1
//   → [10.0.0.2, 10.0.0.1, 203.0.113.7] 에서 index 1 = 10.0.0.1
//
// hops=0(기본)이면 XFF를 아예 보지 않는다. 프록시가 없는데 신뢰하면
// 클라이언트가 헤더 한 줄로 "요청마다 새 IP"를 만들어 제한을 통째로 우회한다.
// 반대로 프록시가 있는데 0이면 전원이 한 키로 묶인다. 홉 수는 배포 형태를
// 아는 사람이 정확히 세어 넣어야 하는 값이다.
export function clientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  hops: number = trustedHops()
): string {
  const remote = remoteAddress || "unknown";
  if (hops <= 0) return remote;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
  const chain = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse(); // 오른쪽(우리와 가까운 쪽)부터

  const addrs = [remote, ...chain];
  // 홉 수가 실제 체인보다 크면 클라이언트가 써넣은 값을 그대로 믿게 된다.
  // 그럴 바엔 우리가 확실히 아는 가장 왼쪽 값에서 멈춘다.
  return addrs[Math.min(hops, addrs.length - 1)] ?? remote;
}
