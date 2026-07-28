import { useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { uploadDocument, deleteDocument } from "../api";
import DocModal from "./DocModal";
import type { DocumentSummary } from "../types";

interface Props {
  documents: DocumentSummary[];
  onChanged: () => Promise<void>;
  loadError: string | null;
}

export default function Sidebar({ documents, onChanged, loadError }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDocId, setOpenDocId] = useState<number | null>(null);
  // 좁은 화면에서 문서 구역을 접어둔다. 폰에서 정작 아쉬운 건 답변을 읽을
  // 세로 공간이고, 문서 목록은 올릴 때·지울 때만 잠깐 필요하기 때문이다.
  //
  // 화면 폭을 여기서 재지 않는 이유: matchMedia를 걸면 리사이즈마다 리렌더가
  // 붙고, 무엇보다 "좁다"의 기준이 CSS와 JS 두 곳으로 갈라진다. 대신 접는
  // 버튼과 접힘 규칙 자체를 모바일 미디어 쿼리 안에만 둬서, 데스크톱에서는
  // 이 값이 무엇이든 사이드바가 늘 펼쳐져 보이게 했다.
  const [docsOpen, setDocsOpen] = useState(false);

  async function handleFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일을 다시 선택해도 change 이벤트가 오도록 비워둔다
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(e: MouseEvent, id: number): Promise<void> {
    e.stopPropagation(); // 문서 클릭(모달 열기)으로 번지지 않게
    if (!confirm("이 문서를 삭제할까요?")) return;
    try {
      await deleteDocument(id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }

  // 오류가 있으면 접혀 있어도 펼친다. 오류 문구가 접힌 구역 안에 있으면
  // 폰에서는 "문서 0개"만 남아, 아직 안 올린 것과 못 불러온 것이 똑같아 보인다.
  const expanded = docsOpen || !!(error || loadError);

  return (
    <aside className={expanded ? "sidebar sidebar-open" : "sidebar"}>
      <div className="sidebar-head">
        <h1>DocChat</h1>
        <p className="tagline">올린 문서를 근거로만 답하는 챗봇</p>
        {/* 좁은 화면에서만 보인다(.sidebar-toggle은 기본이 display:none). */}
        <button
          className="sidebar-toggle"
          onClick={() => setDocsOpen((v) => !v)}
          aria-expanded={expanded}
          aria-controls="sidebar-docs"
        >
          <span>문서 {documents.length}개</span>
          <span className="sidebar-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>

      <div className="sidebar-body" id="sidebar-docs">
        <button className="upload-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? "임베딩 처리 중..." : "문서 업로드 (txt, md)"}
        </button>
        <input
          type="file"
          ref={fileRef}
          accept=".txt,.md"
          onChange={(e) => void handleFile(e)}
          hidden
        />

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
              <button className="doc-delete" onClick={(e) => void handleDelete(e, d.id)}>
                삭제
              </button>
            </div>
          ))}
          {!loadError && documents.length === 0 && (
            <p className="doc-empty">아직 업로드한 문서가 없습니다.</p>
          )}
        </div>
      </div>

      {openDocId != null && (
        <DocModal docId={openDocId} onClose={() => setOpenDocId(null)} onSaved={onChanged} />
      )}
    </aside>
  );
}
