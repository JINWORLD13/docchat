// /api/chat 에 동시 요청을 퍼부어 처리량(RPS)과 지연(p95/p99)을 잰다.
// 반드시 서버를 LLM_PROVIDER=mock 으로 띄운 상태에서 돌린다.
//   → 외부 LLM(내가 못 빠르게 하는 부분)을 빼고,
//     내가 통제하는 부분(HTTP·검색·캐시·풀)의 성능만 순수하게 측정하기 위해서다.
//
// 사용법: CONN=20 DUR=10 node scripts/load-chat.ts
import autocannon from "autocannon";
import type { MetricsResponse } from "../types.ts";

const CONN = Number(process.env.CONN || 20); // 동시 연결 수 (트래픽 폭주 정도)
const DUR = Number(process.env.DUR || 10); // 몇 초 동안

async function metrics(): Promise<MetricsResponse | null> {
  try {
    return (await (await fetch("http://localhost:4000/api/metrics")).json()) as MetricsResponse;
  } catch {
    return null;
  }
}

console.log(`부하: 동시 ${CONN}, ${DUR}초\n`);

const instance = autocannon(
  {
    url: "http://localhost:4000/api/chat",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "환불은 며칠 걸려?" }),
    connections: CONN,
    duration: DUR,
  },
  async (err, r) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log("\n=== 결과 ===");
    console.log(`처리량(RPS) 평균: ${r.requests.average.toFixed(0)} req/s`);
    console.log(`지연 평균: ${r.latency.average.toFixed(1)} ms`);
    console.log(`지연 p97.5: ${r.latency.p97_5.toFixed(1)} ms`);
    console.log(`지연 p99: ${r.latency.p99.toFixed(1)} ms`);
    console.log(`총 요청: ${r.requests.total}`);
    console.log(
      `  2xx(정상): ${r["2xx"]} | 429(과부하 거절): ${r["4xx"]} | ` +
        `5xx(서버오류): ${r["5xx"]} | 타임아웃: ${r.timeouts}`
    );

    const m = await metrics();
    if (m) {
      console.log(
        `\n캐시 적중률: ${m.cache.hitRate} (hit ${m.cache.hits} / miss ${m.cache.misses})`
      );
      // Bulkhead로 풀을 둘로 나눈 뒤로 m.pool은 없어졌다. JS일 땐 이 줄이
      // undefined를 찍고 있었는데, 타입을 붙이고 나서야 드러났다.
      console.log(
        `읽기 풀: 열림 ${m.readPool.total} / 놀고있음 ${m.readPool.idle} / 대기 ${m.readPool.waiting}`
      );
      console.log(
        `쓰기 풀: 열림 ${m.writePool.total} / 놀고있음 ${m.writePool.idle} / 대기 ${m.writePool.waiting}`
      );
    }
    process.exit(0);
  }
);
autocannon.track(instance, { renderProgressBar: true });
