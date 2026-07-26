import { useState, type FormEvent } from "react";
import type { RoomSummary } from "./types";

interface Props {
  rooms: RoomSummary[];
  current: string | null;
  nickname: string;
  onSelect: (room: string) => void;
  onDelete: (room: string) => void;
}

// 왼쪽 방 목록.
// 방 "생성"과 "입장"이 같은 동작이다 — 없는 이름으로 들어가면 그 자리에서
// 만들어진다. 서버에 방을 미리 등록하는 절차를 따로 두지 않은 이유는,
// 아무도 없는 방을 목록에 남겨둘 방법이 없기 때문이다(비면 정리된다).
export default function RoomList({ rooms, current, nickname, onSelect, onDelete }: Props) {
  const [newRoom, setNewRoom] = useState("");

  function create(e: FormEvent) {
    e.preventDefault();
    const name = newRoom.trim();
    if (!name) return;
    onSelect(name);
    setNewRoom("");
  }

  function remove(name: string) {
    // 되돌릴 수 없다 — 방에 있던 사람들이 밖으로 나가고 대화 기록도 사라진다.
    if (!confirm(`#${name} 방을 삭제할까요? 대화 기록도 함께 사라져요.`)) return;
    onDelete(name);
  }

  return (
    <aside className="roomlist">
      <div className="roomlist-me">
        <span className="roomlist-me-dot" />
        {nickname}
      </div>

      <form className="roomlist-new" onSubmit={create}>
        <input
          placeholder="새 방 이름"
          value={newRoom}
          onChange={(e) => setNewRoom(e.target.value)}
          maxLength={30}
        />
        <button type="submit" disabled={!newRoom.trim()}>
          만들기
        </button>
      </form>

      <div className="roomlist-title">
        열려 있는 방 {rooms.length > 0 && <span>{rooms.length}</span>}
      </div>

      <div className="roomlist-items">
        {rooms.length === 0 && (
          <p className="roomlist-empty">
            아직 열린 방이 없어요. 위에서 새 방을 만들어보세요.
          </p>
        )}
        {/* 방 한 줄은 버튼 두 개(입장·삭제)다. 삭제를 방 버튼 안에 넣을 수는
            없다 — button 안에 button은 넣을 수 없는 마크업이라, 줄 자체를
            div으로 감싸고 나란히 둔다. */}
        {rooms.map((r) => (
          <div key={r.name} className="roomlist-row">
            <button
              className={"roomlist-item" + (r.name === current ? " active" : "")}
              onClick={() => onSelect(r.name)}
            >
              <span className="roomlist-name">#{r.name}</span>
              <span className="roomlist-count">{r.users}</span>
            </button>
            {/* 내가 만든 방에만 보인다. 진짜 권한 확인은 서버가 한다 —
                이건 눌러도 거절당할 버튼을 띄우지 않기 위한 것이다. */}
            {r.owner === nickname && (
              <button
                className="roomlist-del"
                onClick={() => remove(r.name)}
                title="방 삭제"
                aria-label={`${r.name} 방 삭제`}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
