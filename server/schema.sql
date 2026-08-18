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

-- ---------- 계정 ----------
--
-- 지금까지 신원은 "이 브라우저"(clientKey HMAC — realtime/identity.ts)였다.
-- 메신저가 되려면 신원이 기기를 넘어 유지돼야 하고, DM의 수신자·읽음 표시의
-- 주체·대화 기록의 작성자가 전부 이 id를 가리킨다.
create table if not exists users (
  -- uuid인 이유: 대화 상대에게 노출되는 값이라(작성자 표시) 연속 정수면
  -- 가입 순서와 규모가 새고, 번호를 바꿔가며 프로필을 훑을 수 있다.
  id uuid primary key,
  -- 로그인 아이디. 소문자로 정규화해 저장한다 — Kim과 kim이 다른 계정이 되면
  -- 로그인 실패의 원인을 본인도 알 수 없다.
  username text not null unique,
  -- scrypt(소금:해시, server/auth.ts). 게스트 계정은 로그인이 불가능해야 하므로
  -- 어떤 비밀번호와도 일치할 수 없는 빈 값을 둔다.
  password_hash text not null,
  -- 대화에서 보이는 이름. 로그인 아이디와 분리한다 — 아이디는 바꿀 수 없지만
  -- 보이는 이름은 바꿀 수 있어야 하고, 아이디를 화면에 뿌리면 로그인 자격의
  -- 절반(아이디+비밀번호 중 아이디)을 방 전체에 공개하는 셈이다.
  display_name text not null,
  -- 한 번 눌러 들어온 손님. 포트폴리오 데모는 가입 없이 바로 써봐야 하므로
  -- 게스트도 정식 user 행으로 만든다 — 그래야 메시지·읽음·DM의 모든 로직이
  -- "user가 아닐 수도 있는" 분기 없이 한 가지 모양으로 돈다.
  is_guest boolean not null default false,
  created_at timestamptz not null default now()
);

-- 로그인 세션. 토큰은 httpOnly 쿠키로만 오간다(server/auth.ts).
-- JWT 대신 DB 세션인 이유: 로그아웃이 "정말로" 로그아웃이어야 해서다.
-- JWT는 서버가 잊을 방법이 없어 만료까지 유효한데, 그러면 공용 PC에서
-- 로그아웃해도 토큰을 복사해둔 사람이 계속 그 사람이다.
create table if not exists sessions (
  -- 토큰 자체를 키로 쓴다. 256비트 무작위라 추측이 불가능하고,
  -- 조회가 전부 "토큰으로 찾기"라 별도 인덱스도 필요 없다.
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- 만료 세션 청소(cleanupSessions)가 훑는 축.
create index if not exists sessions_expires_at_idx on sessions (expires_at);
