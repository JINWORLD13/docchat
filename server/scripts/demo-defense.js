// 방어 레이어 시연.
//   MODE=burst   COUNT=15 node scripts/demo-defense.js   → Rate Limiter (한 IP 폭주 차단)
//   MODE=breaker COUNT=9  node scripts/demo-defense.js   → Circuit Breaker + Degradation
const COUNT = Number(process.env.COUNT || 15);
const MODE = process.env.MODE || "burst";
const CHAT = "http://localhost:4000/api/chat";
const METRICS = "http://localhost:4000/api/metrics";

async function once() {
  const t = performance.now();
  const res = await fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "환불은 며칠 걸려?" }),
  });
  let degraded = false;
  const text = await res.text().catch(() => "");
  if (res.ok) degraded = text.includes("답변 생성이 어려워");
  return { status: res.status, ms: performance.now() - t, degraded };
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
    const m = await (await fetch(METRICS)).json();
    const tag = r.degraded ? "degraded(출처만 반환)" : `status ${r.status}`;
    console.log(
      `#${String(i + 1).padStart(2)} ${tag.padEnd(22)} ${r.ms.toFixed(0).padStart(4)}ms | ` +
        `breaker ${m.breaker.open ? "OPEN " : "closed"}(연속실패 ${m.breaker.consecutiveFailures})`
    );
  }
  console.log("\n회로가 열린 뒤부터는 LLM을 부르지 않아 지연이 뚝 떨어진다(느린 실패 → 즉시 대체).");
}
process.exit(0);
