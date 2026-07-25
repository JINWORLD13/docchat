import { useRef, useState } from "react";
import { uploadDocument, deleteDocument } from "../api.js";
import DocModal from "./DocModal.jsx";

export default function Sidebar({ documents, onChanged, loadError }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [openDocId, setOpenDocId] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일을 다시 선택해도 change 이벤트가 오도록 비워둔다
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(e, id) {
    e.stopPropagation(); // 문서 클릭(모달 열기)으로 번지지 않게
    if (!confirm("이 문서를 삭제할까요?")) return;
    try {
      await deleteDocument(id);
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <aside className="sidebar">
      <h1>DocChat</h1>
      <p className="tagline">올린 문서를 근거로만 답하는 챗봇</p>

      <button
        className="upload-btn"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? "임베딩 처리 중..." : "문서 업로드 (txt, md)"}
      </button>
      <input type="file" ref={fileRef} accept=".txt,.md" onChange={handleFile} hidden />

      {(error || loadError) && <div className="sidebar-error">{error || loadError}</div>}

      <div className="doc-list">
        {documents.map((d) => (
          <div
            key={d.id}
            className="doc"
            onClick={() => setOpenDocId(d.id)}
            title="클릭해서 내용 보기 / 수정"
          >
            <div className="doc-info">
              <div className="doc-name">{d.filename}</div>
              <div className="doc-meta">청크 {d.chunk_count}개</div>
            </div>
            <button className="doc-delete" onClick={(e) => handleDelete(e, d.id)}>
              삭제
            </button>
          </div>
        ))}
        {!loadError && documents.length === 0 && (
          <p className="doc-empty">아직 업로드한 문서가 없습니다.</p>
        )}
      </div>

      {openDocId != null && (
        <DocModal
          docId={openDocId}
          onClose={() => setOpenDocId(null)}
          onSaved={onChanged}
        />
      )}
    </aside>
  );
}
