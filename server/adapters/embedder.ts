// Embedder 포트의 DocChat 구현 — 공급자 라우팅(embedding.ts) + 회로 차단기.
//
// 회로가 코어가 아니라 여기 있는 이유: 건강 상태를 추적하는 건 외부 호출을
// 실제로 하는 쪽의 일이다. 코어는 "지금 못 쓴다"는 사실만 알면 되고, 그건
// DependencyUnavailableError로 전달한다. 덕분에 회로차단기를 쓰지 않는 앱
// (CLI, 로컬 Ollama)에서도 코어가 그대로 돈다.
//
// 어느 공급자(Gemini·Ollama)로 갈지는 embedding.ts가 정한다. 생성과 달리
// 임베딩은 공급자를 런타임에 갈아탈 수 없어서(벡터 공간이 달라진다 —
// embedding.ts 주석) 여기는 "지금 고른 하나"에 회로를 씌울 뿐이다.
// 그래서 회로도 하나(breaker.embed)면 된다.
//
// 임베딩 회로를 생성 회로와 나눠 둔 이유는 breaker.ts에 적어뒀다 —
// 둘은 실패했을 때 할 수 있는 일이 다르다(출처를 돌려줄 수 있나 없나).

import { embedQuery } from "../embedding.ts";
import * as breaker from "../breaker.ts";
import { DependencyUnavailableError, type Embedder } from "../rag/types.ts";

export const queryEmbedder: Embedder = {
  async embedQuery(text: string): Promise<number[]> {
    // 회로가 열려 있으면 재시도(0.5+1+2초)로 처리 슬롯을 붙잡지 않고 즉시 알린다.
    // 이 검사는 반열림 시험권을 소비하므로 요청 경로에서만 부른다.
    if (breaker.embed.isOpen()) throw new DependencyUnavailableError("embedding");

    try {
      const vector = await embedQuery(text);
      breaker.embed.onSuccess();
      return vector;
    } catch (e) {
      // 이 기록이 없으면 임베딩 API가 죽어도 회로가 영영 안 열린다.
      breaker.embed.onFailure();
      throw e;
    }
  },
};
