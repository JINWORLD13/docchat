create extension if not exists vector;

create table if not exists documents (
  id serial primary key,
  filename text not null,
  -- 원문. 청크는 겹쳐서 잘리므로 원문을 그대로 복원할 수 없어서 따로 보관한다.
  -- (문서 열람/수정 기능에서 이 값을 보여주고 갱신한다)
  content text not null default '',
  uploaded_at timestamptz not null default now()
);

create table if not exists chunks (
  id serial primary key,
  document_id int not null references documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  -- gemini-embedding-001을 outputDimensionality=768로 사용 (gemini.ts와 맞춰야 함)
  embedding vector(768) not null
);

-- 코사인 거리(<=>) 검색용 인덱스
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- 외래키 쪽(참조하는 컬럼)에도 인덱스를 준다.
-- Postgres는 참조되는 쪽(documents.id)에만 자동으로 인덱스를 만들어주고,
-- 참조하는 쪽은 만들어주지 않는다. 그래서 없으면 세 군데가 전부 순차 스캔이 된다:
--   - DELETE /api/documents/:id — cascade가 지울 chunks를 찾느라
--   - PUT /api/documents/:id — 재임베딩 전 기존 청크를 지우는데, 그게 트랜잭션
--     안에서 일어나 쓰기 풀(max 5) 커넥션을 그동안 붙잡고 있다
--   - GET /api/documents — 목록마다 chunks 전체를 조인해 개수를 센다
-- 문서 수가 적을 땐 안 보이다가, 코퍼스가 커지면 셋 다 같이 느려진다.
create index if not exists chunks_document_id_idx on chunks (document_id);

-- 채팅에 올린 이미지.
-- 바이트를 DB에 직접 담는다(bytea). 파일시스템에 두면 배포 환경마다 디스크가
-- 휘발되거나 여러 대일 때 서로 안 보이는 문제가 생기는데, 그걸 피하려고
-- 이미 있는 DB에 맡겼다. 대신 큰 값이 DB로 들어오므로 업로드 크기를 제한하고
-- (routes/images.ts) 조회는 전용 커넥션 풀로 격리한다 (db.ts의 mediaPool).
--
-- id가 uuid인 이유: URL에 그대로 노출되므로 연속된 정수면 남의 이미지를
-- 번호만 바꿔가며 훑을 수 있다.
create table if not exists chat_images (
  id uuid primary key,
  mime text not null,
  bytes bytea not null,
  -- 화면에서 자리를 미리 잡아 이미지가 뜰 때 대화가 밀리지 않게 하려고 같이 둔다.
  -- 클라이언트가 잰 값이라 신뢰하지 않고 저장 전에 범위를 자른다.
  width int not null,
  height int not null,
  created_at timestamptz not null default now()
);

-- 보관 기간이 지난 이미지를 지울 때 쓴다 (server/images.ts의 cleanupImages).
-- 이게 없으면 정리 작업이 매번 테이블 전체를 훑는데, 하필 그 테이블이
-- 바이트를 통째로 담고 있어서 제일 무겁다.
create index if not exists chat_images_created_at_idx on chat_images (created_at);

-- 질문마다 유사도/토큰/응답시간을 남긴다.
-- 거절 임계값(SIMILARITY_THRESHOLD) 튜닝은 이 로그의 top_similarity를 보고 한다.
create table if not exists query_logs (
  id serial primary key,
  question text not null,
  answer text,
  refused boolean not null default false,
  top_similarity real,
  prompt_tokens int,
  output_tokens int,
  latency_ms int,
  created_at timestamptz not null default now()
);

-- 임계값 튜닝은 "최근 로그"를 보는 일이라 항상 created_at으로 정렬·필터한다.
-- 이 테이블은 질문마다 한 줄씩 영원히 쌓이는 유일한 테이블이므로,
-- 인덱스가 없으면 시간이 갈수록 그 조회가 느려진다.
create index if not exists query_logs_created_at_idx on query_logs (created_at desc);
