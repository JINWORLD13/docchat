// VectorStore 포트의 DocChat 구현 — Postgres + pgvector.
//
// 코어에서 SQL을 들어낸 자리다. 저장소를 Qdrant나 사내 검색엔진으로 바꾸는
// 일이 이 파일 하나를 갈아끼우는 일이 된다.

import { readPool } from "../db.ts";
import type { RetrievedChunk, Scope, VectorStore } from "../rag/types.ts";

export const pgVectorStore: VectorStore = {
  async search(vector: number[], k: number, scope: Scope): Promise<RetrievedChunk[]> {
    // 아직 문서에 소유 그룹 컬럼이 없다. 그래서 범위가 지정된 요청은 조용히
    // 전체 검색으로 흘려보내지 않고 여기서 막는다 — 권한 필터가 없는데 있는
    // 척하는 게 없는 걸 아는 것보다 훨씬 위험하다.
    // (Keycloak을 붙일 때 documents.allowed_groups를 추가하고 아래 쿼리에
    //  `and d.allowed_groups && $3` 를 더하면 이 가드는 사라진다.)
    if (scope.groups !== null) {
      throw new Error("권한 범위 검색은 아직 구현되지 않았습니다 (documents에 그룹 컬럼 없음).");
    }

    // <=>는 pgvector의 코사인 거리 연산자. 거리가 작을수록 비슷하다.
    // 읽기 풀 사용 — 이 경로가 사수 대상(질문 응답)이라 쓰기와 격리한다.
    const { rows } = await readPool.query<RetrievedChunk>(
      `select c.content, d.filename,
              1 - (c.embedding <=> $1::vector) as similarity
         from chunks c
         join documents d on d.id = c.document_id
        order by c.embedding <=> $1::vector
        limit $2`,
      [JSON.stringify(vector), k]
    );

    return rows;
  },
};
