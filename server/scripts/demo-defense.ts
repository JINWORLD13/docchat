// 방어 레이어 시연.
//   MODE=burst   COUNT=15 node scripts/demo-defense.ts   → Rate Limiter (한 IP 폭주 차단)
//   MODE=breaker COUNT=9  node scripts/demo-defense.ts   → Circuit Breaker + Degradation
import type { MetricsResponse } from "../types.ts";
import { guestCookie } from "./session.ts";

const COUNT = Number(process.env.COUNT || 15);
const MODE = process.env.MODE || "burst";
const BASE = process.env.DEMO_URL || "http://localhost:4000";
const CHAT = `${BASE}/api/chat`;
const METRICS = `${BASE}/api/metrics`;

// 질문 경로가 로그인을 요구하므로 게스트로 한 번 입장해 쿠키를 들고 다닌다.
// 없으면 전부 401이 되어 "Rate Limiter가 막았다"와 구분이 안 된다 —
// 이 스크립트는 어느 레이어가 막았는지를 보여주는 게 목적이라 치명적이다.
const cookie = await guestCookie(BASE, "demo");

interface Attempt {
  status: number;
  ms: number;
  degraded: boolean;
}

async function once(): Promise<Attempt> {
  const t = performance.now();
  const res = await fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ question: "환불은 며칠 걸려?" }),
  });
  const text = await res.text().catch(() => "");
  const degraded = res.ok && text.includes("답변 생성이 어려워");
  return { status: res.status, ms: performance.now() - t, degraded };
}

// fetch().json()은 any를 준다. 서버가 실제로 뭘 주는지는 런타임에만 알 수 있으니
// 타입은 "이 모양일 것"이라는 선언이다 — 서버와 같은 타입을 가리키게 해서,
// 서버에서 필드가 바뀌면 여기 사용처가 컴파일 에러로 드러나게 한다.
async function metrics(): Promise<MetricsResponse> {
  return (await fetch(METRICS)).json() as Promise<MetricsResponse>;
}

if (MODE === "burst") {
  // 한 IP에서 순식간에 COUNT발을 동시에 → Rate Limiter가 몇 개를 튕기나
  const results = await Promise.all(Array.from({ length: COUNT }, once));
  const ok = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429).length;
  console.log(`한 IP에서 동시 ${COUNT}발`);
  console.log(`  통과(200): ${ok}`);
  console.log(`  거절(429): ${limited}   ← Rate Limiter가 막은 폭주`);
} else if (MODE === "breaker") {
  // 순차로 COUNT개 (LLM_FAIL=1 서버에서). 회로가 열리는 순간과 지연 변화를 본다.
  for (let i = 0; i < COUNT; i++) {
    const r = await once();
    const m = await metrics();
    const tag = r.degraded ? "degraded(출처만 반환)" : `status ${r.status}`;
    console.log(
      `#${String(i + 1).padStart(2)} ${tag.padEnd(22)} ${r.ms.toFixed(0).padStart(4)}ms | ` +
        `breaker ${m.breaker.open ? "OPEN " : "closed"}(연속실패 ${m.breaker.consecutiveFailures})`
    );
  }
  console.log(
    "\n회로가 열린 뒤부터는 LLM을 부르지 않아 지연이 뚝 떨어진다(느린 실패 → 즉시 대체)."
  );
}
process.exit(0);
