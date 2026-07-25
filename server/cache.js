import NodeCache from "node-cache";

// 질문 임베딩 캐시.
// 같은 질문(또는 자주 반복되는 질문)이 들어올 때마다 임베딩 API를 다시 부르면
// 매번 네트워크 왕복 + rate limit 압박이 생긴다. 한 번 만든 벡터를 캐싱해 재사용한다.
//
// 지금은 인메모리(node-cache)다. 서버가 한 대라 이걸로 충분하다.
// 서버를 여러 대로 늘리면 인스턴스마다 캐시가 따로 놀아 적중률이 떨어지므로,
// 그때 Redis 같은 공유 캐시로 바꾼다. (Cosmos Tarot 프로젝트가 Redis를 쓰는 이유)
// 함수 세 개(get/set/stats)만 노출해서, 나중에 Redis 구현으로 교체해도
// 부르는 쪽(gemini.js)은 안 바뀌게 했다.
const cache = new NodeCache({
  stdTTL: 600, // 10분 지나면 만료 (문서가 바뀌면 임베딩도 달라질 수 있어 무한 보관은 안 함)
  maxKeys: 5000, // 메모리 상한. 초과하면 set이 에러를 던지므로 아래에서 삼킴
  checkperiod: 120, // 2분마다 만료된 키 청소
});

export function getCached(key) {
  return cache.get(key);
}

export function setCached(key, value) {
  try {
    cache.set(key, value);
  } catch {
    // maxKeys 초과 시 던지는 에러는 무시한다. 캐시는 있으면 좋고 없어도 되는 것이라,
    // 캐시가 꽉 찼다고 실제 요청을 실패시키면 안 된다.
  }
}

// 적중률 측정용. { hits, misses, keys, ... }
export function cacheStats() {
  return cache.getStats();
}
