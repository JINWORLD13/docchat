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
