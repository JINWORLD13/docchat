import { useState, type FormEvent } from "react";

interface Props {
  onSubmit: (nickname: string) => void;
}

// 채팅에 들어가는 첫 단계. 닉네임만 받는다.
// 방은 여기서 안 고른다 — 어떤 방이 있는지 보려면 먼저 소켓이 붙어야 하고,
// 소켓을 붙이려면 닉네임이 필요하기 때문이다. 그래서 두 단계로 나눴다.
export default function Nickname({ onSubmit }: Props) {
  const [value, setValue] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const nickname = value.trim();
    if (!nickname) return;
    onSubmit(nickname);
  }

  return (
    <div className="join">
      <form className="join-card" onSubmit={submit}>
        <h1>실시간 채팅</h1>
        <p className="join-sub">사용할 닉네임을 정해주세요.</p>
        <input
          placeholder="닉네임"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={20}
          autoFocus
        />
        <button type="submit" disabled={!value.trim()}>
          시작하기
        </button>
      </form>
    </div>
  );
}
