/// <reference types="vite/client" />

// Vite가 주입하는 환경변수. 기본 타입은 아무 이름이나 any로 통과시켜서,
// 오타를 내도 조용히 undefined가 흘러간다. 우리가 쓰는 것만 여기 적어두면
// 이름을 틀렸을 때 컴파일에서 걸린다.
interface ImportMetaEnv {
  // 관리자 토큰. 빌드 산출물에 평문으로 들어가므로 넣는다는 건 곧
  // "장애 주입 데모를 방문자에게 공개한다"는 선택이다 (api.ts 주석 참고).
  readonly VITE_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
