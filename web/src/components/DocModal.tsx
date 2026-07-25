import { useEffect, useState } from "react";
import { fetchDocument, updateDocument } from "../api";

interface Props {
  docId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

// 문서 열람/수정 팝업.
// 열릴 때 원문을 불러오고, 저장하면 재임베딩까지 서버가 처리한다.
export default function DocModal({ docId, onClose, onSaved }: Props) {
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchDocument(docId)
      .then((doc) => {
        if (!alive) return;
        setFilename(doc.filename);
        setContent(doc.content);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "문서를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [docId]);

  // ESC로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave(): Promise<void> {
    if (!content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDocument(docId, content);
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "수정에 실패했습니다.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 title={filename}>{filename || "문서"}</h2>
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        {loading ? (
          <div className="modal-loading">불러오는 중...</div>
        ) : (
          <textarea
            className="modal-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={saving}
            spellCheck={false}
          />
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-foot">
          <span className="modal-hint">저장하면 내용을 다시 임베딩해서 검색에 반영합니다.</span>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={onClose} disabled={saving}>
              닫기
            </button>
            <button
              className="btn-primary"
              onClick={() => void handleSave()}
              disabled={loading || saving || !content.trim()}
            >
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
