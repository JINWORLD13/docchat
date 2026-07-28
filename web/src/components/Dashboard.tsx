import { useEffect, useRef, useState } from "react";
import { fetchMetrics, setFault, resetDefense, burst } from "../api";
import type { MetricsResponse } from "../types";

// 부하·장애 대응 실시간 대시보드.
// 버튼으로 상황(트래픽 폭주 / LLM 장애)을 주입하고, 방어 레이어가 어떻게
// 반응하는지 지표와 이벤트 로그로 실시간 관찰한다.

type LogKind = "info" | "ok" | "warn" | "danger";

interface LogEntry {
  id: number;
  t: string;
  text: string;
  kind: LogKind;
}

let logSeq = 0;

// --- 탭을 옮겨도 남아야 하는 것 ---
//
// 이 화면이 보여주는 건 "지금 값"이 아니라 "값이 어떻게 변했는가"다. 그런데 그
// 기록(이벤트 로그)과 비교 기준(직전 스냅샷)이 컴포넌트 안에 있으면 다른 탭을
// 누르는 순간 함께 사라진다. 장애를 주입해둔 채 탭을 옮겼다 오면 서버는 여전히
// 장애 상태인데 화면은 "버튼을 눌러 상황을 주입해보세요"가 된다 — 아무 일도
// 없었던 것과 구분이 안 되는, 이 화면이 가장 하면 안 되는 표시다.
// (지표 자체는 서버에 있으니 폴링이 1초 안에 다시 채운다)
//
// 컴포넌트 바깥에 두는 이유는 언마운트를 견뎌야 하기 때문이고, 그래서 아래
// pushLog는 화면이 없는 동안 도착한 결과(진행 중이던 폭주의 결과 로그)도
// 기록한다 — 돌아오면 그 줄이 로그에 남아 있다.
let logStore: LogEntry[] = [];
let lastMetrics: MetricsResponse | null = null;

function pushLog(text: string, kind: LogKind): LogEntry[] {
  logSeq += 1;
  logStore = [
    { id: logSeq, t: new Date().toLocaleTimeString(), text, kind },
    ...logStore,
  ].slice(0, 30);
  return logStore;
}

// 관측이 끊겼던 구간을 로그에 남길 때 쓰는 문구.
// 같은 줄이 연달아 쌓이지 않게 맨 위와 비교하는 데도 쓴다 — StrictMode는
// 개발 모드에서 effect를 두 번 돌리므로 그냥 넣으면 두 줄이 된다.
const RESUMED = "관측 재개 — 다른 탭에 있는 동안의 변화는 기록되지 않았습니다";

export default function Dashboard() {
  const [m, setM] = useState<MetricsResponse | null>(null);
  const [faultOn, setFaultOn] = useState(false);
  const [log, setLog] = useState<LogEntry[]>(logStore);
  const [busy, setBusy] = useState(false);
  // 서버에 닿지 못하는 상태. null이면 정상.
  const [offline, setOffline] = useState<string | null>(null);
  // 폴링이 겹치는 걸 막는다. 응답이 1초보다 오래 걸리면 요청이 쌓이고,
  // 늦게 온 응답이 먼저 온 응답을 덮어써 비교 기준(lastMetrics)이 뒤죽박죽이 된다 —
  // 하필 그 상황(서버가 느려진 상황)이 회로 전이를 정확히 봐야 할 때다.
  const inFlight = useRef(false);
  // 장애 토글 직후 잠깐은 폴링이 버튼 상태를 되돌리지 못하게 막는다.
  // 이미 날아가 있던 요청이 예전 값을 들고 늦게 도착하면 버튼이 깜빡인다.
  const holdFaultUntil = useRef(0);

  function addLog(text: string, kind: LogKind = "info"): void {
    setLog(pushLog(text, kind));
  }

  // 1초마다 metrics 폴링 + 상태 전이 감지
  useEffect(() => {
    // 관측이 멈췄던 구간을 눈에 보이게 표시한다. 이 화면은 "안 보고 있던 사이"와
    // "아무 일도 없었던 사이"를 절대 같게 보여주면 안 된다.
    // lastMetrics가 있다는 건 전에 한 번 관측했다는 뜻이다(= 첫 방문이 아니다).
    if (lastMetrics && logStore[0]?.text !== RESUMED) addLog(RESUMED, "info");

    let alive = true;
    const tick = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const data = await fetchMetrics();
        if (!alive) return;
        // 비교 기준도 컴포넌트 바깥에 있다. 그래서 탭을 옮겨 있는 동안 회로가
        // 열렸다면, 돌아온 뒤 첫 폴링이 그 전이를 잡아낸다 (시각은 돌아온 시각).
        const p = lastMetrics;
        if (p && !p.breaker.open && data.breaker.open) {
          addLog("Circuit Breaker 열림 — LLM 연속 실패 감지", "danger");
        }
        if (p && p.breaker.open && !data.breaker.open) {
          addLog("Circuit Breaker 닫힘 — 정상 복구", "ok");
        }
        lastMetrics = data;
        setM(data);
        if (Date.now() >= holdFaultUntil.current) setFaultOn(data.faults.llmFail);
        setOffline((was) => {
          if (was) addLog("서버 연결 복구", "ok");
          return null;
        });
      } catch (e) {
        if (!alive) return;
        // 예전엔 여기서 조용히 삼켰다. 그러면 "서버가 죽었다"와 "모든 지표가
        // 0이라 완벽히 건강하다"가 화면에서 똑같이 보인다 — 신뢰성 대시보드가
        // 유일하게 헷갈리면 안 되는 두 상태다.
        setOffline((was) => {
          if (!was) addLog("서버에 연결하지 못했습니다 — 지표는 마지막 값입니다", "danger");
          return e instanceof Error ? e.message : "연결 실패";
        });
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function handleBurst(n: number): Promise<void> {
    setBusy(true);
    addLog(`트래픽 폭주 주입: 한 번에 ${n}발`, "warn");
    try {
      const r = await burst(n);
      const parts = [`정상 ${r.ok}`, `429거절 ${r.rejected}`];
      if (r.degraded) parts.push(`degraded ${r.degraded}`);
      if (r.refused) parts.push(`문서없음 ${r.refused}`);
      // 실패 건수를 반드시 보여준다. 예전엔 집계만 하고 화면에 안 띄워서,
      // 서버가 죽어 20건이 전부 실패해도 초록색으로 "정상 0, 429거절 0"이
      // 찍혔다 — 아무것도 안 됐는데 성공을 보고하는 셈이었다.
      if (r.error) parts.push(`실패 ${r.error}`);
      const kind: LogKind = r.error ? "danger" : r.rejected ? "warn" : "ok";
      addLog(`결과 → ${parts.join(", ")}`, kind);
    } finally {
      setBusy(false);
    }
  }

  async function toggleFault(): Promise<void> {
    const next = !faultOn;
    try {
      await setFault(next);
    } catch (e) {
      addLog(e instanceof Error ? e.message : "장애 주입에 실패했습니다.", "danger");
      return;
    }
    holdFaultUntil.current = Date.now() + 1500;
    setFaultOn(next);
    addLog(
      next ? "LLM 장애 주입 ON — 생성이 실패하기 시작" : "LLM 장애 해제",
      next ? "danger" : "ok"
    );
  }

  async function handleReset(): Promise<void> {
    try {
      await resetDefense();
    } catch (e) {
      addLog(e instanceof Error ? e.message : "리셋에 실패했습니다.", "danger");
      return;
    }
    holdFaultUntil.current = Date.now() + 1500;
    setFaultOn(false);
    addLog("리셋 — 장애 해제 + 회로 초기화", "info");
  }

  const rl = m?.rateLimit;
  const ad = m?.admission;
  const br = m?.breaker;
  const eb = m?.embedBreaker;
  const rt = m?.realtime;

  return (
    <div className="dash">
      <div className="dash-head">
        <h2>부하·장애 대응 대시보드</h2>
        <p>상황을 주입하고, 방어 레이어가 반응하는 걸 실시간으로 관찰합니다.</p>
      </div>

      {offline && (
        <div className="dash-offline">
          서버에 연결하지 못했습니다 ({offline}). 아래 지표는 마지막으로 받은 값입니다.
        </div>
      )}

      <div className="dash-controls">
        <button onClick={() => void handleBurst(20)} disabled={busy}>
          {busy ? "주입 중..." : "트래픽 폭주 (동시 20)"}
        </button>
        <button className={faultOn ? "danger-btn" : ""} onClick={() => void toggleFault()}>
          LLM 장애 {faultOn ? "ON" : "OFF"}
        </button>
        <button onClick={() => void handleReset()}>리셋</button>
      </div>

      <div className="layers">
        <Layer
          name="Rate Limiter"
          // HTTP 질문과 채팅 메시지가 같은 Token Bucket 구현을 쓴다
          // (server/tokenbucket.ts). 값만 다르다.
          sub="사용자별 요청 제한 (HTTP · 소켓 공용)"
          active={(rl?.rejected ?? 0) > 0 || (rt?.messagesRejected ?? 0) > 0}
          stat={
            `누적 거절 ${rl?.rejected ?? 0}` +
            ((rt?.messagesRejected ?? 0) > 0 ? ` · 채팅 도배 ${rt?.messagesRejected}` : "")
          }
        />
        <Arrow />
        <Layer
          name="Admission Control"
          sub="동시 처리 상한 + 대기 데드라인"
          active={(ad?.queued ?? 0) > 0}
          stat={
            `처리중 ${ad?.inFlight ?? 0}/${ad?.maxInFlight ?? "-"} · 대기 ${ad?.queued ?? 0}` +
            // 큐가 꽉 차 즉시 튕긴 것과, 기다리다 데드라인에 포기한 것을 구분해 보여준다.
            // 둘은 원인이 다르다 — 전자는 지속 과부하, 후자는 처리가 느려졌다는 신호.
            ((ad?.rejected ?? 0) > 0 ? ` · 거절 ${ad?.rejected}` : "") +
            ((ad?.timedOut ?? 0) > 0 ? ` · 대기포기 ${ad?.timedOut}` : "")
          }
        />
        <Arrow />
        <Layer
          name="Bulkhead"
          // 채팅 이미지를 붙이면서 풀이 셋이 됐다. 사진이 많은 방 하나가
          // 질문 응답용 읽기 풀을 굶기지 않는지 여기서 확인한다.
          sub="읽기 / 쓰기 / 미디어 풀 격리"
          active={
            (m?.writePool.waiting ?? 0) > 0 ||
            (m?.readPool.waiting ?? 0) > 0 ||
            (m?.mediaPool.waiting ?? 0) > 0
          }
          stat={
            `읽기 대기 ${m?.readPool.waiting ?? 0} · 쓰기 대기 ${m?.writePool.waiting ?? 0}` +
            ` · 미디어 대기 ${m?.mediaPool.waiting ?? 0}`
          }
        />
        <Arrow />
        <Layer
          name="Circuit Breaker"
          // 회로가 둘인 이유: 질문 경로가 외부로 나가는 지점이 둘이다(임베딩·생성).
          // 예전엔 생성만 감싸고 있어서, 임베딩 API가 죽으면 회로가 영영 안 열린 채
          // 요청마다 재시도를 다 소진하고 실패했다. 화면에도 "닫힘"으로만 보였다.
          sub="외부 API 장애 자동 차단 (임베딩 · 생성)"
          active={(br?.open ?? false) || (eb?.open ?? false)}
          danger={(br?.open ?? false) || (eb?.open ?? false)}
          stat={
            (br?.open
              ? `생성 열림 · ${Math.ceil(br.reopensInMs / 1000)}s 후 재시도`
              : `생성 닫힘 · 연속실패 ${br?.consecutiveFailures ?? 0}`) +
            (eb?.open
              ? ` · 임베딩 열림 · ${Math.ceil(eb.reopensInMs / 1000)}s`
              : (eb?.consecutiveFailures ?? 0) > 0
                ? ` · 임베딩 실패 ${eb?.consecutiveFailures}`
                : "")
          }
        />
      </div>

      <div className="metrics-grid">
        <Metric label="캐시 적중률" value={m ? `${Math.round(m.cache.hitRate * 100)}%` : "-"} />
        <Metric
          label="읽기 풀 대기"
          value={m?.readPool.waiting ?? "-"}
          warn={(m?.readPool.waiting ?? 0) > 0}
        />
        <Metric label="처리 중 / 상한" value={ad ? `${ad.inFlight} / ${ad.maxInFlight}` : "-"} />
        <Metric label="회로 상태" value={br?.open ? "열림" : "닫힘"} warn={br?.open} />
        <Metric
          label="실시간 채팅 접속"
          value={rt ? `${rt.rooms}방 · ${rt.users}명` : "-"}
        />
      </div>

      <div className="event-log">
        <div className="event-log-title">이벤트 로그</div>
        {log.length === 0 && <div className="event-empty">버튼을 눌러 상황을 주입해보세요.</div>}
        {log.map((e) => (
          <div key={e.id} className={`event ${e.kind}`}>
            <span className="event-time">{e.t}</span>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}

interface LayerProps {
  name: string;
  sub: string;
  active: boolean;
  danger?: boolean;
  stat: string;
}

function Layer({ name, sub, active, danger, stat }: LayerProps) {
  const cls = ["layer", active ? (danger ? "layer-danger" : "layer-active") : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <div className="layer-name">{name}</div>
      <div className="layer-sub">{sub}</div>
      <div className="layer-stat">{stat}</div>
    </div>
  );
}

function Arrow() {
  return <div className="layer-arrow">↓</div>;
}

function Metric({
  label,
  value,
  warn,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
}) {
  return (
    <div className={`metric ${warn ? "metric-warn" : ""}`}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
