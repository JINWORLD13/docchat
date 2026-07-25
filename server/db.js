import pg from "pg";

// Bulkhead(자원 풀 격리) — 배의 방수격벽처럼 커넥션 풀을 용도별로 나눈다.
//
// 왜: 한 종류의 작업이 커넥션을 다 먹어버리면 다른 작업까지 멈춘다.
// 문서 업로드나 로그 쓰기(느리고 몰릴 수 있음)가 커넥션을 독차지하면,
// 정작 사용자 질문(검색)이 커넥션을 못 얻어 챗봇 전체가 멈추는 상황이 생긴다.
// 그래서 "질문 검색용(읽기)"과 "쓰기용(업로드·로그)"을 별도 풀로 격리한다.
// 쓰기가 폭주해 writePool이 포화돼도, readPool은 멀쩡해 질문 응답은 계속된다.

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/docchat";

const common = {
  connectionString,
  idleTimeoutMillis: 30000, // 놀고 있는 연결은 30초 뒤 반납
  connectionTimeoutMillis: 5000, // 5초 안에 연결 못 얻으면 실패 (무한 대기 방지)
};

// 사용자 질문 경로(검색). 사수해야 하는 핵심이라 넉넉히.
export const readPool = new pg.Pool({ ...common, max: Number(process.env.PG_READ_MAX || 10) });

// 업로드·로그 쓰기. 여기가 포화돼도 읽기(질문)는 영향받지 않는다.
export const writePool = new pg.Pool({ ...common, max: Number(process.env.PG_WRITE_MAX || 5) });

// 기존 코드 호환용 기본 export는 읽기 풀.
export default readPool;
