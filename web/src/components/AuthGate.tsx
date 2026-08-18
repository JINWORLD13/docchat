import { useState, type FormEvent } from "react";
import { guestLogin, login, signup } from "../api";
import type { Me } from "../types";

interface Props {
  onAuthed: (me: Me) => void;
}

// 들어오는 문 — 이 화면을 지나야 앱이 열린다(App.tsx).
//
// 게스트 입장을 기본으로 앞세운 이유: 포트폴리오 데모는 회원가입을 요구하는
// 순간 대부분이 돌아선다. 닉네임 하나로 바로 들어가게 하되, 서버는 게스트도
// 정식 계정으로 만들어(users 행) 이후의 모든 기능이 한 모양으로 돈다.
// 정식 가입은 "기기를 옮겨도 나"가 필요해진 사람이 스스로 선택한다.
type Mode = "guest" | "login" | "signup";

export default function AuthGate({ onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>("guest");
  const [nickname, setNickname] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 모드가 바뀌어도 입력값은 안 지운다 — 가입하려다 "이미 있는 아이디"를 보고
  // 로그인으로 넘어가는 흐름에서 아이디를 다시 치게 하지 않으려고.
  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "guest") onAuthed(await guestLogin(nickname.trim()));
      else if (mode === "login") onAuthed(await login(username.trim(), password));
      else onAuthed(await signup(username.trim(), password, displayName.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const ready =
    mode === "guest"
      ? nickname.trim().length > 0
      : username.trim().length > 0 && password.length > 0;

  return (
    <div className="join">
      <form className="join-card" onSubmit={(e) => void submit(e)}>
        <h1>DocChat</h1>
        <p className="join-sub">
          {mode === "guest" && "닉네임만 정하면 바로 시작할 수 있어요."}
          {mode === "login" && "계정으로 로그인해요."}
          {mode === "signup" && "계정을 만들면 어디서든 이어서 쓸 수 있어요."}
        </p>

        {mode === "guest" && (
          <input
            placeholder="닉네임"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={20}
            autoFocus
          />
        )}

        {mode !== "guest" && (
          <>
            <input
              placeholder="아이디 (영문 소문자·숫자·밑줄)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={20}
              autoComplete="username"
              autoFocus
            />
            <input
              type="password"
              placeholder={mode === "signup" ? "비밀번호 (8자 이상)" : "비밀번호"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={72}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </>
        )}

        {mode === "signup" && (
          <input
            placeholder="대화에서 보일 이름 (비우면 아이디)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={20}
          />
        )}

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" disabled={!ready || busy}>
          {mode === "guest" ? "바로 시작하기" : mode === "login" ? "로그인" : "가입하기"}
        </button>

        <div className="auth-links">
          {mode !== "guest" && (
            <button type="button" onClick={() => switchMode("guest")}>
              게스트로 시작
            </button>
          )}
          {mode !== "login" && (
            <button type="button" onClick={() => switchMode("login")}>
              로그인
            </button>
          )}
          {mode !== "signup" && (
            <button type="button" onClick={() => switchMode("signup")}>
              회원가입
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
