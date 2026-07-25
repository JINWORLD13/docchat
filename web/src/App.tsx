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

      {view === "chat" && (
        <div className="app">
          <Sidebar documents={documents} onChanged={refresh} loadError={loadError} />
          <Chat hasDocuments={documents.length > 0} />
        </div>
      )}
      {view === "live" && <LiveChat />}
      {view === "dashboard" && <Dashboard />}
    </div>
  );
}
