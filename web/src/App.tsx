import { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import LiveChat from "./realtime/LiveChat";
import { fetchDocuments } from "./api";
import type { DocumentSummary } from "./types";

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
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");

  const refresh = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
      setLoadError(null);
    } catch {
      setLoadError("문서 목록을 불러오지 못했습니다. 서버와 DB가 켜져 있는지 확인해주세요.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      {view === "live" && <LiveChat />}
      {view === "dashboard" && <Dashboard />}
    </div>
  );
}
