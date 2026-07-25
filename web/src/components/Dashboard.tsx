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

export default function Dashboard() {
  const [m, setM] = useState<MetricsResponse | null>(null);
  const [faultOn, setFaultOn] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  // 서버에 닿지 못하는 상태. null이면 정상.
  const [offline, setOffline] = useState<string | null>(null);
  const prev = useRef<MetricsResponse | null>(null);
  // 폴링이 겹치는 걸 막는다. 응답이 1초보다 오래 걸리면 요청이 쌓이고,
  // 늦게 온 응답이 먼저 온 응답을 덮어써 prev가 뒤죽박죽이 된다 —
  // 하필 그 상황(서버가 느려진 상황)이 회로 전이를 정확히 봐야 할 때다.
  const inFlight = useRef(false);
  // 장애 토글 직후 잠깐은 폴링이 버튼 상태를 되돌리지 못하게 막는다.
  // 이미 날아가 있던 요청이 예전 값을 들고 늦게 도착하면 버튼이 깜빡인다.
  const holdFaultUntil = useRef(0);

  function addLog(text: string, kind: LogKind = "info"): void {
    logSeq += 1;
    setLog((l) =>
      [{ id: logSeq, t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 30)
    );
  }

  // 1초마다 metrics 폴링 + 상태 전이 감지
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const data = await fetchMetrics();
        if (!alive) return;
        const p = prev.current;
        if (p && !p.breaker.open && data.breaker.open) {
          addLog("Circuit Breaker 열림 — LLM 연속 실패 감지", "danger");
        }
        if (p && p.breaker.open && !data.breaker.open) {
          addLog("Circuit Breaker 닫힘 — 정상 복구", "ok");
        }
        prev.current = data;
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
          sub="LLM 장애 자동 차단"
          active={br?.open ?? false}
          danger={br?.open ?? false}
          stat={
            br?.open
              ? `열림 · ${Math.ceil(br.reopensInMs / 1000)}s 후 재시도`
              : `닫힘 · 연속실패 ${br?.consecutiveFailures ?? 0}`
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
