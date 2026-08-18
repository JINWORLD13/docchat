// 측정·시연 스크립트가 쓸 로그인.
//
// 질문 경로(/api/chat)가 로그인을 요구하게 되면서(server/index.ts) 생겼다.
// 이 스크립트들은 브라우저가 아니라 쿠키 항아리가 없으므로, 게스트로 한 번
// 입장해 받은 세션 쿠키를 직접 들고 다녀야 한다.
//
// 게스트를 쓰는 이유: 아이디·비밀번호를 스크립트나 환경변수에 심지 않아도
// 되고, 실제 방문자가 데모를 시작하는 경로와 같기 때문이다. 측정 대상이
// 바뀌지도 않는다 — 세션 확인은 요청당 캐시 조회 한 번이고(server/auth.ts),
// 그건 원래 실사용에서도 매 요청에 붙는 비용이라 빼고 재면 오히려 거짓이 된다.

// Set-Cookie에서 sid 값만 꺼낸다. 서버가 붙이는 부가 속성(Path·HttpOnly 등)은
// 우리가 되돌려 보낼 때 필요 없다.
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /(?:^|[;,\s])sid=([^;,\s]+)/.exec(setCookie);
  return match?.[1] ?? null;
}

// 게스트로 입장해 요청에 그대로 붙일 수 있는 Cookie 헤더 값을 돌려준다.
export async function guestCookie(
  baseUrl: string,
  displayName = "loadtest"
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    // 여기서 조용히 넘어가면 뒤이은 요청이 전부 401이 되고, 측정 결과는
    // "처리량 매우 높음"으로 나온다 — 아무 일도 안 하고 튕긴 응답이라서.
    // 그런 숫자는 없느니만 못하므로 바로 멈춘다.
    throw new Error(
      `게스트 입장 실패 (${res.status}). 서버가 떠 있는지, DB가 연결됐는지 확인해주세요.`
    );
  }
  const sid = sidFrom(res.headers.get("set-cookie"));
  if (!sid) throw new Error("게스트 입장 응답에 세션 쿠키가 없습니다.");
  return `sid=${sid}`;
}
