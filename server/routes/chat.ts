// 문서 Q&A 라우트 — RAG 코어를 HTTP/SSE에 연결하는 얇은 층.
//
// 이 파일에는 "전송"과 "과부하 제어"만 남아 있다. 질문을 어떻게 검색하고
// 언제 거절하고 어떻게 degrade할지는 전부 rag/engine.ts가 정한다.
// 그 경계 덕분에 나중에 Teams 봇을 붙일 때 이 파일에 해당하는 것만 새로 쓰면 된다.
//
// 신뢰성 레이어를 코어에 넣지 않은 이유:
//   - 회로 차단기는 "외부 호출이 죽었을 때"를 다루므로 어댑터의 일이다(adapters/).
//   - admission은 "요청이 몰릴 때"를 다루므로 요청을 받는 이 층의 일이다.
// 코어가 이걸 알면 CLI처럼 둘 다 필요 없는 앱에서도 끌고 다니게 된다.

import { Router } from "express";
import { acquire, release } from "../admission.ts";
import { engine, UNRESTRICTED } from "../composition.ts";
import { loadImage } from "../images.ts";
import type { ChatEvent, QuestionImage } from "../types.ts";

const router = Router();

// id는 우리가 발급한 uuid만 받는다 (routes/images.ts와 같은 기준).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 생성 모델이 읽을 수 있는 이미지 형식. 업로드(routes/images.ts)는 실시간
// 채팅과 공용이라 gif도 통과시키지만, Gemini의 이미지 이해는 gif를 지원하지
// 않는다. 여기서 안 거르면 업로드는 멀쩡히 되고 질문만 500으로 터지는 데다,
// 사용자 실수가 LLM 회로 차단기에 실패로 쌓인다 — 몇 명이 gif를 올리면
// 회로가 열려 멀쩡한 질문까지 degrade되는, 남 탓으로 열리는 회로가 된다.
const GENERATABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

// 엔진 조립은 composition.ts로 옮겼다 — 전송이 둘(웹 SSE, 카카오톡 스킬)이
// 되면서, 각자 조립하면 정책이 어긋난 두 시스템이 되기 때문이다.
// 이 파일에는 원래 취지대로 "전송"과 "과부하 제어"만 남는다.

router.post("/", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();

  // 검증 규칙 자체는 코어가 갖고 있고, 이 층은 그걸 HTTP 상태코드로 옮기기만 한다.
  const valid = engine.validate(question);
  if (!valid.ok) {
    res.status(400).json({ error: valid.message });
    return;
  }

  // 클라이언트가 떠났는지.
  //
  // 이게 없으면 사용자가 탭을 닫아도 서버는 LLM 스트림을 끝까지 받아 읽고,
  // 이미 죽은 소켓에 계속 write한다. 그동안 admission 슬롯(MAX_INFLIGHT=8) 하나가
  // 잡혀 있으므로, 성질 급한 사용자가 몇 번 새로고침하면 아무도 안 보는 응답들이
  // 처리 슬롯을 다 차지한다 — admission.ts가 피하려던 바로 그 상황이다.
  //
  // 등록 위치가 중요하다. 예전엔 이 리스너를 acquire() 뒤에 붙였는데, 그러면
  // 큐에서 기다리는 동안(최대 2초) 끊긴 연결을 영영 못 알아챈다 — Node는 이미
  // 발생한 이벤트를 늦게 붙인 리스너에게 다시 주지 않기 때문이다. 과부하 때
  // 새로고침을 연타하면 죽은 요청들이 큐 자리를 데드라인까지 차지하고, 승격된
  // 뒤에는 아무도 안 보는 응답을 생성하느라 슬롯까지 잡았다.
  // 감시는 "기다리기 전"부터 시작해야 한다.
  //
  // 이 신호는 코어에도 그대로 넘어간다. 코어는 이걸로 생성을 중단하고, 상류
  // (Gemini)까지 끊는다 — 우리 쪽 루프를 빠져나오는 것만으로는 이미 열린 응답이
  // 닫히지 않아, 사용자가 떠난 뒤에도 생성이 끝까지 돌고 토큰이 과금된다.
  const upstream = new AbortController();
  res.on("close", () => upstream.abort());
  const aborted = (): boolean => upstream.signal.aborted;

  // 질문에 첨부된 이미지(선택). 실시간 채팅과 같은 저장소·업로드 경로를 쓴다 —
  // 프런트가 POST /api/chat/image로 올리고 받은 id만 여기 실어 보낸다.
  // (id가 아니라 url이나 바이트를 직접 받지 않는 이유는 realtime/gateway.ts 참고)
  //
  // 바이트를 admission 앞에서 읽을지 고민한 자리다. 뒤로 미루면 잘못된 id가
  // 400 대신 처리 슬롯을 잡은 채로 실패한다 — "잘못된 요청이 슬롯을 잡아먹지
  // 않게 검증을 앞에 둔다"는 이 파일의 기준과 어긋난다. 대신 큐에서 기다리는
  // 동안(최대 2초) 바이트가 메모리에 얹힌다 — 이미지 2MB × 대기열 상한 20 =
  // 40MB가 최악이라 감수한다. 존재만 앞에서 확인하고 바이트는 슬롯 안에서
  // 읽는 절충도 있지만, 그건 DB 왕복이 두 번이 되고 그 사이 보관 기간 정리가
  // 행을 지우는 틈도 생긴다.
  let image: QuestionImage | undefined;
  const rawImageId: unknown = req.body?.imageId;
  if (rawImageId !== undefined && rawImageId !== null) {
    // 모양부터 확인한다. 안 하면 쓰레기 문자열이 uuid 컬럼 비교까지 내려가
    // Postgres 에러를 왕복시킨다 (realtime/gateway.ts의 image 핸들러와 같은 이유).
    if (typeof rawImageId !== "string" || !UUID.test(rawImageId)) {
      res.status(400).json({ error: "이미지를 찾을 수 없어요. 다시 올려주세요." });
      return;
    }
    let stored: Awaited<ReturnType<typeof loadImage>>;
    try {
      stored = await loadImage(rawImageId);
    } catch (e) {
      // DB 실패는 "없는 이미지"와 다르다. 없다고 말하면 사용자는 멀쩡한
      // 이미지를 계속 다시 올린다.
      console.error("chat image load error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "이미지를 읽지 못했어요. 잠시 후 다시 시도해주세요." });
      return;
    }
    if (!stored) {
      // 애초에 없던 id거나, 보관 기간(24시간)이 지나 정리된 이미지다.
      res.status(400).json({ error: "이미지를 찾을 수 없어요. 다시 올려주세요." });
      return;
    }
    if (!GENERATABLE.has(stored.mime)) {
      res.status(400).json({ error: "GIF는 질문에 쓸 수 없어요. PNG·JPG·WebP로 올려주세요." });
      return;
    }
    image = { mime: stored.mime, data: stored.bytes };
  }

  // [과부하 제어] 자리를 못 얻으면 무한 대기 대신 즉시 429로 거절한다(load shedding).
  // 검증(빈 질문·길이)은 이 앞에서 처리한다 — 잘못된 요청이 처리 슬롯을 잡아먹지 않게.
  const admitted = await acquire();
  if (!admitted) {
    res.setHeader("Retry-After", "1");
    res
      .status(429)
      .json({ error: "요청이 많아 잠시 처리할 수 없어요. 잠시 후 다시 시도해주세요." });
    return;
  }

  // 기다리는 사이에 떠났으면 여기서 끝낸다. 자리를 얻자마자 반납하는 셈이라
  // 뒤에 선 살아 있는 요청에게 그만큼 빨리 넘어간다.
  if (aborted()) {
    release();
    res.end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 보낼 수 있는 이벤트를 ChatEvent 유니온으로 못박는다.
  // 프런트(web/src/types.ts)가 같은 유니온을 읽으므로, 코어에 이벤트를 하나
  // 추가하면 프런트에서 처리를 빠뜨렸을 때 타입 검사에 걸린다.
  const send = (data: ChatEvent): void => {
    if (aborted() || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const event of engine.ask(question, UNRESTRICTED, upstream.signal, image)) {
      send(event);
    }
  } catch (e) {
    // 코어는 자기 실패를 error 이벤트로 바꿔 내보내므로 여기까지 오는 건
    // 전송 자체가 깨진 경우다. 그때는 보낼 곳이 없으니 기록만 남긴다.
    console.error("chat transport error:", e);
  } finally {
    res.end();
    release(); // 성공·실패·거절 무엇이든 자리는 반드시 반납
  }
});

export default router;
