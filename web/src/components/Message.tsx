import { displaySize } from "../images";
import type { SourceRef, Usage } from "../types";

// 채팅 화면에 쌓이는 항목. role로 갈리는 유니온이라, user 메시지에서
// sources나 usage를 읽으려 하면 컴파일에서 걸린다 (애초에 없는 값이니까).
export interface UserMessage {
  role: "user";
  content: string;
  // 보낸 시각. 카카오톡처럼 말풍선 옆에 작게 보여준다.
  ts?: number;
  // 질문에 첨부한 이미지. url은 보낸 쪽 브라우저의 object URL이다 —
  // 서버 주소로 다시 받아올 이유가 없다(원본 파일이 이 브라우저에 있다).
  // width/height는 원본 크기. 표시 크기는 그릴 때 계산한다(realtime과 동일).
  image?: { url: string; width: number; height: number };
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  ts?: number;
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

// 말풍선 옆에 붙는 시각. 값이 없으면(스트리밍 중 생긴 옛 메시지 등) 그냥 비운다.
function timeOf(ts: number | undefined): string | null {
  if (ts === undefined) return null;
  return new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export default function Message({ message }: { message: ChatItem }) {
  const time = timeOf(message.ts);

  if (message.role === "user") {
    return (
      <div className="msg-row mine">
        {/* 시간은 말풍선 밖, 내 말풍선은 오른쪽이므로 시간이 왼쪽에 붙는다
            (카카오톡과 같은 배치 — realtime의 Bubble도 동일) */}
        <div className="msg-line">
          {time && <span className="msg-time">{time}</span>}
          <div className="message user">
            {message.image && (
              // 크기를 미리 박아두면 이미지가 로드되기 전에도 자리가 잡힌다.
              // (속성으로 주고 CSS의 max-width: 100%가 좁은 화면에서 비율을
              //  유지한 채 줄인다 — realtime 말풍선과 같은 원리)
              <img
                className="question-image"
                src={message.image.url}
                alt="질문에 첨부한 이미지"
                {...displaySize(message.image.width, message.image.height)}
              />
            )}
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  const cls = [
    "message",
    "assistant",
    message.refused ? "refused" : "",
    message.error ? "error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 봇을 대화 상대처럼 보여준다 — 아바타와 이름이 있어야 "챗봇과 나눈 대화"로
  // 읽힌다. 아바타는 파비콘과 같은 💬 (이 앱의 얼굴을 하나로 유지).
  return (
    <div className="msg-row bot">
      <div className="avatar" aria-hidden>
        💬
      </div>
      <div className="msg-col">
        <div className="msg-name">DocChat</div>
        <div className="msg-line">
          <MessageBody cls={cls} message={message} />
          {time && <span className="msg-time">{time}</span>}
        </div>
      </div>
    </div>
  );
}

function MessageBody({ cls, message }: { cls: string; message: AssistantMessage }) {
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

      {/* 입력·출력 토큰은 각각 따로 없을 수 있다(usage 타입이 그렇게 돼 있다).
          예전엔 입력 토큰만 보고 두 값을 함께 그려서, 출력 수가 안 오면
          "출력 " 뒤가 빈 채로 남았다. 있는 값만 골라 이어 붙인다. */}
      {(message.usage?.promptTokens != null || message.usage?.outputTokens != null) && (
        <div className="usage">
          토큰 —{" "}
          {[
            message.usage.promptTokens != null ? `입력 ${message.usage.promptTokens}` : null,
            message.usage.outputTokens != null ? `출력 ${message.usage.outputTokens}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}
