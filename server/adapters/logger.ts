// QueryLogger 포트의 DocChat 구현 — query_logs 테이블.
//
// 거절 임계값(SIMILARITY_THRESHOLD) 튜닝은 여기 쌓인 top_similarity를 보고 한다.

import { writePool } from "../db.ts";
import type { QueryLogger, QueryLogRecord } from "../rag/types.ts";

export const pgQueryLogger: QueryLogger = {
  // 관측 기록을 사용자 응답 경로에서 뺀다. 로그를 기다리느라 사용자 응답이
  // 늦을 이유가 없고, 부하 때 요청당 DB 왕복을 하나 줄인다.
  log(record: QueryLogRecord): void {
    // 로그는 쓰기 풀로. 로그가 몰려도 질문 검색(읽기 풀)은 영향받지 않는다.
    writePool
      .query(
        `insert into query_logs
           (question, answer, refused, top_similarity, prompt_tokens, output_tokens, latency_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.question,
          record.answer,
          record.refused,
          record.topSimilarity,
          record.promptTokens,
          record.outputTokens,
          record.latencyMs,
        ]
      )
      .catch((e: unknown) => {
        console.error("query_logs insert 실패:", e instanceof Error ? e.message : e);
      });
  },
};
