# DocChat — 프런트엔드

DocChat의 화면입니다. React + Vite + TypeScript로 만들었고, 상단 탭 세 개로
문서 Q&A · 실시간 채팅 · 부하/장애 대시보드를 오갑니다.

프로젝트 전체 설명(무엇을 만들었고 왜 그렇게 했는지, DB·서버 실행 방법)은
[루트 README](../README.md)에 있습니다. 이 문서는 이 디렉터리를 다룰 때 필요한
것만 적습니다.

## 실행

서버(`../server`)와 DB가 먼저 떠 있어야 합니다.

```bash
npm install
npm run dev   # http://localhost:5173
```

## 스크립트

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | Vite 개발 서버 (HMR, 아래 프록시 적용) |
| `npm run build` | `tsc -b`로 타입 검사한 뒤 `vite build` |
| `npm run typecheck` | 타입 검사만 (`tsc -b`, 산출물 없음) |
| `npm run lint` | oxlint |
| `npm run preview` | 빌드 결과(`dist/`)를 그대로 띄워 확인 |

서버 쪽은 빌드 단계가 없지만(Node가 타입만 벗겨 실행) 프런트는 Vite가 번들해야
하므로 `build`가 있습니다.

## 개발 서버 프록시

`vite.config.ts`에서 두 경로를 4000번(서버)으로 넘깁니다. 그래서 프런트 코드는
`/api/...`처럼 같은 오리진으로만 요청하면 되고, CORS나 주소 분기가 없습니다.

- `/api` → `http://localhost:4000` (문서 Q&A REST + SSE 스트리밍)
- `/socket.io` → `http://localhost:4000`, **`ws: true`** (실시간 채팅)

`ws: true`가 빠지면 처음 polling 핸드셰이크만 성공하고 WebSocket 업그레이드에서
조용히 실패해, 채팅이 계속 polling으로 돕니다. 화면은 멀쩡히 동작하는 것처럼
보이는데 전송 방식만 바뀌어 있어서 알아채기 어렵습니다.

## 환경 변수

`.env.example`을 참고하세요. 지금 쓰는 값은 `VITE_ADMIN_TOKEN` 하나뿐이고,
로컬 개발에서는 필요 없습니다(서버가 루프백 요청을 그대로 통과시킵니다).
`VITE_` 접두사가 붙은 값은 빌드 산출물에 평문으로 들어간다는 점만 주의합니다.

## 디렉터리

```
src/
  types.ts          서버와 맞춘 계약 (문서 · SSE 이벤트 · metrics)
  api.ts            fetch + SSE 파싱 (이벤트별 핸들러 디스패치)
  App.tsx           상단 탭 — 문서 Q&A / 실시간 채팅 / 대시보드
  components/       Sidebar(업로드·목록) / Chat / Message(근거 표시)
                    DocModal(열람·수정 팝업) / Dashboard(부하·장애 대시보드)
  realtime/
    types.ts        소켓 이벤트 계약 (server/realtime/types.ts와 짝)
    socket.ts       타입 있는 소켓 (같은 오리진에 연결)
    LiveChat.tsx    소켓 연결 관리 + 닉네임 → 로비 → 방 전환
    Nickname.tsx    닉네임 입력
    RoomList.tsx    방 목록 + 새 방 만들기
    Room.tsx        구독 · 전송 · 접속자 목록
```

`src/realtime/types.ts`는 `server/realtime/types.ts`와 같은 내용을 각자 들고
있습니다. 지금 규모에서는 워크스페이스를 도입하는 비용이 더 커서 미뤘고, 한쪽만
고치면 어긋납니다.
