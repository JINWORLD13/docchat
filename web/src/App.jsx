import { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import Dashboard from "./components/Dashboard.jsx";
import { fetchDocuments } from "./api.js";

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [view, setView] = useState("chat");

  const refresh = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
      setLoadError(null);
    } catch {
      setLoadError("문서 목록을 불러오지 못했습니다. 서버와 DB가 켜져 있는지 확인해주세요.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="root">
      <nav className="topnav">
        <span className="brand">DocChat</span>
        <button className={view === "chat" ? "nav-active" : ""} onClick={() => setView("chat")}>
          채팅
        </button>
        <button className={view === "dashboard" ? "nav-active" : ""} onClick={() => setView("dashboard")}>
          대시보드
        </button>
      </nav>

      {view === "chat" ? (
        <div className="app">
          <Sidebar documents={documents} onChanged={refresh} loadError={loadError} />
          <Chat hasDocuments={documents.length > 0} />
        </div>
      ) : (
        <Dashboard />
      )}
    </div>
  );
}
