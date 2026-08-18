import { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import AuthGate from "./components/AuthGate";
import LiveChat from "./realtime/LiveChat";
import { fetchDocuments, fetchMe, logout, setSessionExpiredHandler } from "./api";
import type { DocumentSummary, Me } from "./types";

// 탭 목록을 값 하나로 두고 타입을 거기서 뽑아낸다.
// 이러면 탭을 추가할 때 배열만 고치면 되고, setView("오타") 같은 실수는
// 컴파일에서 걸린다.
const TABS = [
  { id: "chat", label: "문서 Q&A" },
  { id: "live", label: "실시간 채팅" },
  { id: "dashboard", label: "대시보드" },
] as const;

type View = (typeof TABS)[number]["id"];

export default function App() {
  // undefined = 아직 확인 중(첫 요청이 안 돌아옴), null = 로그인 안 됨.
  // 셋을 구분하는 이유: 확인 중에 AuthGate를 먼저 그리면, 이미 로그인된
  // 사람도 새로고침할 때마다 로그인 화면이 번쩍였다 사라진다.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");

  useEffect(() => {
    // 세션이 끊기면(만료·다른 탭에서 로그아웃·서버가 세션을 지움) 어느 요청이든
    // 401을 받는다. 그때 화면 전체를 로그인으로 되돌린다 — 등록을 fetchMe보다
    // 먼저 하는 이유는, 그 사이에 나간 요청의 401을 놓치지 않기 위해서다.
    //
    // setMe(null)을 그대로 넘기지 않고 감싸는 이유: setMe에 함수를 넘기면
    // React가 그걸 "이전 값으로 다음 값을 만드는 함수"로 해석한다.
    setSessionExpiredHandler(() => setMe(null));

    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
      setLoadError(null);
    } catch {
      setLoadError("문서 목록을 불러오지 못했습니다. 서버와 DB가 켜져 있는지 확인해주세요.");
    }
  }, []);

  useEffect(() => {
    if (me) void refresh();
  }, [me, refresh]);

  async function handleLogout() {
    await logout().catch(() => undefined); // 실패해도 화면은 로그아웃한다
    // 새로고침으로 모든 상태(소켓·대화·저장된 방)를 깨끗이 비운다.
    // state만 지우면 소켓이 옛 세션 쿠키로 붙어 있던 흔적이 남는다.
    location.reload();
  }

  if (me === undefined) return null; // 확인 중 — 어차피 수십 ms라 빈 화면이 깜빡임보다 낫다
  if (!me) return <AuthGate onAuthed={setMe} />;

  return (
    <div className="root">
      <nav className="topnav">
        <span className="brand">DocChat</span>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={view === tab.id ? "nav-active" : ""}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <div className="topnav-me">
          <span className="topnav-name">
            {me.displayName}
            {me.isGuest && <span className="topnav-guest"> 게스트</span>}
          </span>
          <button onClick={() => void handleLogout()}>로그아웃</button>
        </div>
      </nav>

      {/* 문서 Q&A만 언마운트하지 않고 CSS(.tab-hidden)로 가린다.
          이 탭은 상태를 되살릴 방법이 없다. 대화 내용은 서버에 남지 않고,
          무엇보다 답변이 흘러나오는 중이라면 언마운트가 곧 abort다
          (Chat.tsx의 정리 함수). 질문을 던져놓고 대시보드를 잠깐 봤다 오면
          기다리던 답변이 통째로 사라지는 셈이었다.

          대시보드처럼 모듈 변수로, 실시간 채팅처럼 sessionStorage로 빼는 길도
          있었지만 여기선 그것만으로 부족하다 — 진행 중인 fetch 리더까지
          컴포넌트 밖으로 들어내야 하고, 스크롤 위치는 여전히 못 지킨다.
          숨긴 채 살려두는 쪽의 대가(안 보는 화면이 계속 일하는 것)는 확인했다:
          Chat에는 타이머도 소켓도 없고, display:none이라 안의 입력창이 Tab
          순서에서도 빠져 포커스를 가로채지 않는다.

          반대로 나머지 두 탭은 켜둔 채로 두면 안 된다. 대시보드는 1초마다
          지표를 폴링하고, 실시간 채팅은 소켓을 붙잡고 방에 남는다 — 아무도
          안 보는 화면 때문에 서버가 계속 일하게 된다. 그래서 이 둘은 지금처럼
          언마운트하고, 각자의 방식으로 되살아난다. */}
      <div className={view === "chat" ? "app" : "app tab-hidden"}>
        <Sidebar documents={documents} onChanged={refresh} loadError={loadError} />
        <Chat hasDocuments={documents.length > 0} active={view === "chat"} />
      </div>
      {view === "live" && <LiveChat me={me} />}
      {view === "dashboard" && <Dashboard />}
    </div>
  );
}
