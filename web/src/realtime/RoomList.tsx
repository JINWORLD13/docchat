import { useState, type FormEvent } from "react";
import type { RoomSummary } from "./types";

interface Props {
  rooms: RoomSummary[];
  current: string | null;
  nickname: string;
  onSelect: (room: string) => void;
}

// 왼쪽 방 목록.
// 방 "생성"과 "입장"이 같은 동작이다 — 없는 이름으로 들어가면 그 자리에서
// 만들어진다. 서버에 방을 미리 등록하는 절차를 따로 두지 않은 이유는,
// 아무도 없는 방을 목록에 남겨둘 방법이 없기 때문이다(비면 정리된다).
export default function RoomList({ rooms, current, nickname, onSelect }: Props) {
  const [newRoom, setNewRoom] = useState("");

  function create(e: FormEvent) {
    e.preventDefault();
    const name = newRoom.trim();
    if (!name) return;
    onSelect(name);
    setNewRoom("");
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
        {rooms.map((r) => (
          <button
            key={r.name}
            className={"roomlist-item" + (r.name === current ? " active" : "")}
            onClick={() => onSelect(r.name)}
          >
            <span className="roomlist-name">#{r.name}</span>
            <span className="roomlist-count">{r.users}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
