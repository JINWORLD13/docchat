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
  -- gemini-embedding-001을 outputDimensionality=768로 사용 (gemini.js와 맞춰야 함)
  embedding vector(768) not null
);

-- 코사인 거리(<=>) 검색용 인덱스
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

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
