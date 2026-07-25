import type { SourceRef, Usage } from "../types";

// 채팅 화면에 쌓이는 항목. role로 갈리는 유니온이라, user 메시지에서
// sources나 usage를 읽으려 하면 컴파일에서 걸린다 (애초에 없는 값이니까).
export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  sources?: SourceRef[];
  usage?: Usage;
  refused?: boolean;
  error?: boolean;
}

export type ChatItem = UserMessage | AssistantMessage;

// LLM이 지시를 어기고 마크다운 서식을 섞어 보낼 때가 있어서,
// 화면에 그대로 노출되지 않게 볼드(**)와 줄머리 헤딩(#)을 걷어낸다.
function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(/^#{1,6}\s+/gm, "");
}

export default function Message({ message }: { message: ChatItem }) {
  if (message.role === "user") {
    return <div className="message user">{message.content}</div>;
  }

  const cls = [
    "message",
    "assistant",
    message.refused ? "refused" : "",
    message.error ? "error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {message.sources && (
        <div className="sources">
          <div className="sources-title">참고한 문서</div>
          {message.sources.map((s) => (
            <div key={s.index} className="source">
              <div className="source-head">
                <span className="source-index">[{s.index}]</span>
                <span className="source-file">{s.filename}</span>
                <span className="source-sim">유사도 {s.similarity.toFixed(2)}</span>
              </div>
              <div className="source-snippet">{s.snippet}…</div>
            </div>
          ))}
        </div>
      )}

      <div className="content">
        {message.content ? stripMarkdown(message.content) : <span className="cursor">▍</span>}
      </div>

      {message.usage?.promptTokens != null && (
        <div className="usage">
          토큰 — 입력 {message.usage.promptTokens} · 출력 {message.usage.outputTokens}
        </div>
      )}
    </div>
  );
}
