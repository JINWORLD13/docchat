// 질문 임베딩 캐시의 효과를 실제 Gemini API로 잰다.
// 첫 호출은 캐시에 없어 진짜 임베딩 API를 부르고(미스),
// 두 번째 호출은 방금 캐싱된 벡터를 그대로 쓴다(히트).
// 부하가 아니라 단발 측정이라, 무료 티어 rate limit을 건드리지 않는다.
import "dotenv/config";
import { embedQuery } from "../gemini.js";

const question = "환불은 며칠 걸려?";

const t1 = performance.now();
await embedQuery(question); // 미스: 실제 임베딩 API 호출
const missMs = performance.now() - t1;

const t2 = performance.now();
await embedQuery(question); // 히트: 캐시에서 즉시
const hitMs = performance.now() - t2;

console.log(`캐시 미스 (실제 임베딩 API): ${missMs.toFixed(1)} ms`);
console.log(`캐시 히트 (인메모리 캐시):   ${hitMs.toFixed(3)} ms`);
console.log(`→ 캐시 히트가 약 ${Math.round(missMs / hitMs)}배 빠름`);
process.exit(0);
