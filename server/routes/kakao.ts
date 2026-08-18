// 카카오톡 스킬 웹훅 — RAG 코어를 오픈빌더에 연결하는 전송층.
//
// routes/chat.ts(SSE)와 같은 코어(composition.ts의 engine)를 쓴다. 이 파일이
// 하는 일은 chat.ts가 SSE에 대해 하는 일과 정확히 같다: 전송 형식 변환과
// 과부하 제어. 검색·거절·degrade 정책은 전부 코어가 정하므로, 웹에서 거절될
// 질문은 카카오톡에서도 같은 문구로 거절된다.
//
// 오픈빌더의 형식 제약(스트리밍 없음·5초 제한)을 다루는 로직은 kakao.ts에
// 있고, 여기는 HTTP와 자원 관리만 남긴다.

import { Router } from "express";
import { acquire, release } from "../admission.ts";
import { engine, UNRESTRICTED } from "../composition.ts";
import {
  callbackWaitResponse,
  collectWithBudget,
  parseSkillPayload,
  simpleTextResponse,
  skillText,
  type SkillResponse,
} from "../kakao.ts";
import { TokenBuckets } from "../tokenbucket.ts";

const router = Router();

// 스킬 URL에 붙이는 비밀 조각. 오픈빌더에는 서명(HMAC) 같은 요청 검증이 없어서,
// 주소를 아는 누구든 가짜 페이로드를 보낼 수 있다 — 특히 callbackUrl을 제3자
// 서버로 적어 우리 답변(과 Gemini 비용)을 임의 주소로 배달시키는 경로가 열린다.
// 그래서 스킬 URL을 /api/kakao/skill/<토큰> 으로 등록하게 하고 토큰을 맞춘다.
// 비워두면 검사하지 않는다(로컬 개발용) — 배포에서는 반드시 설정할 것.
const SKILL_TOKEN = process.env.KAKAO_SKILL_TOKEN || "";

// 5초 중 우리가 쓸 예산. 전부 쓰면 안 된다 — 카카오까지 돌아가는 네트워크와
// 응답 직렬화 몫을 남겨야 5.001초짜리 완답이 아니라 4초짜리 완답이 나간다.
const TIME_BUDGET_MS = Number(process.env.KAKAO_TIME_BUDGET_MS || 3500);

// 콜백은 1분 안에 보내야 한다. 생성이 그보다 오래 매달리면(상류 멈춤 등)
// 여기서 끊는다 — 어차피 늦은 콜백은 카카오가 버린다.
const CALLBACK_DEADLINE_MS = 50_000;

// 사용자별 도배 제한. IP로 걸 수 없다 — 요청이 전부 카카오 서버 IP로 오므로
// IP당 제한은 "전체 사용자 공용" 제한이 된다(clientip.ts가 프록시에서 겪은
// 것과 같은 문제). 대신 페이로드의 카카오 사용자 id로 건다.
const buckets = new TokenBuckets(
  Number(process.env.KAKAO_RL_CAPACITY || 5), // 연속 5개까지
  Number(process.env.KAKAO_RL_REFILL || 0.5) // 2초에 하나씩 회복
);

// 유휴 버킷 회수. 키(사용자 id)에는 "떠났다"는 신호가 없으므로 지우지 않으면
// 말 걸어본 사용자 수만큼 영구히 쌓인다 (routes/images.ts와 같은 이유·같은 방식).
const IDLE_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => buckets.sweep(IDLE_MS), 60 * 1000);
sweeper.unref();

async function postCallback(url: string, body: SkillResponse): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`kakao callback ${res.status}`);
  } catch (e) {
    // 콜백이 실패하면 사용자는 "생각 중"에서 멈춘 화면을 본다. 여기서 더 할 수
    // 있는 게 없으므로(재시도해도 늦은 콜백은 버려진다) 기록만 남긴다.
    console.error("kakao callback 실패:", e instanceof Error ? e.message : e);
  }
}

// 토큰이 설정돼 있으면 경로 조각으로 확인한다. 틀리면 404 — 이 주소에 뭐가
// 있는지조차 알려줄 이유가 없다.
router.post(["/skill", "/skill/:token"], async (req, res) => {
  const token = typeof req.params.token === "string" ? req.params.token : "";
  if (SKILL_TOKEN && token !== SKILL_TOKEN) {
    res.status(404).end();
    return;
  }

  // 여기서부터의 실패는 HTTP 상태코드가 아니라 말로 알린다. 4xx를 돌려주면
  // 사용자에게는 카카오의 일반 오류 문구("응답할 수 없어요")만 보인다 —
  // 무엇이 문제인지는 말풍선으로 전해야 한다.
  const parsed = parseSkillPayload(req.body);
  if (!parsed) {
    // 카카오가 보낸 모양이 아니다. 사람이 볼 말풍선도 없다.
    res.status(400).json({ error: "잘못된 스킬 페이로드입니다." });
    return;
  }

  const valid = engine.validate(parsed.utterance);
  if (!valid.ok) {
    res.json(simpleTextResponse(valid.message));
    return;
  }

  if (!buckets.take(parsed.userId).ok) {
    res.json(simpleTextResponse("질문이 너무 잦아요. 잠깐 쉬었다가 다시 물어봐주세요."));
    return;
  }

  // 예산은 요청 도착부터 잰다. acquire()가 대기열에서 기다린 시간(최대 2초)도
  // 카카오의 5초에 포함되므로, 대기 후 남은 시간만 수집에 쓸 수 있다.
  const deadline = Date.now() + TIME_BUDGET_MS;

  const admitted = await acquire();
  if (!admitted) {
    res.json(simpleTextResponse("지금 질문이 몰려 있어요. 잠시 후 다시 시도해주세요."));
    return;
  }

  // 웹(chat.ts)과 달리 res의 close에 abort를 걸지 않는다. 콜백 경로에서는
  // HTTP 응답을 먼저 끝내고 생성을 계속해야 하는데, close에 걸어두면 응답을
  // 끝내는 순간 스스로 생성을 끊어버린다. 끊는 시점은 아래에서 직접 정한다.
  const upstream = new AbortController();

  try {
    const { first, full } = collectWithBudget(
      engine.ask(parsed.utterance, UNRESTRICTED, upstream.signal),
      Math.max(deadline - Date.now(), 250)
    );

    const head = await first;

    // 예산 안에 끝났다 — 완성된 답을 바로 돌려준다. 대부분 여기로 온다.
    if (head.finished) {
      res.json(simpleTextResponse(skillText(head.snapshot, true)));
      return;
    }

    // 예산 초과 + 콜백 가능: 접수만 알리고, 완성되면 콜백으로 보낸다.
    //
    // admission 슬롯은 여기서 반납하지 않는다(아래 finally까지 잡고 있는다).
    // HTTP 응답은 끝났지만 생성은 계속 돌고 있다 — 슬롯이 지키는 건 연결 수가
    // 아니라 "동시에 도는 무거운 생성 작업 수"라서, 콜백 작업도 자리를 차지해야
    // 웹 쪽 질문과 합쳐서 상한(MAX_INFLIGHT)이 지켜진다.
    if (parsed.callbackUrl) {
      res.json(callbackWaitResponse("문서를 확인하고 있어요. 잠깐만요…"));

      const kill = setTimeout(() => upstream.abort(), CALLBACK_DEADLINE_MS);
      try {
        const done = await full;
        await postCallback(parsed.callbackUrl, simpleTextResponse(skillText(done, true)));
      } finally {
        clearTimeout(kill);
      }
      return;
    }

    // 예산 초과 + 콜백 없음: 생성을 끊고 부분이라도 전한다. 끊지 않으면
    // 아무도 안 받을 뒷부분을 만드느라 토큰과 슬롯만 쓴다 (chat.ts의 abort와
    // 같은 이유 — 여기서는 떠난 게 사용자가 아니라 카카오의 5초 시계다).
    upstream.abort();
    const partial = await full;
    res.json(simpleTextResponse(skillText(partial, false)));
  } catch (e) {
    // collectWithBudget이 오류를 상태로 바꾸므로 여기 오는 건 전송 층 자신의
    // 문제다. 응답을 아직 안 보냈으면 오류 문구라도 보낸다.
    console.error("kakao skill error:", e instanceof Error ? e.message : e);
    if (!res.headersSent) {
      res.json(simpleTextResponse("요청 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요."));
    }
  } finally {
    release(); // 완답·콜백·부분·오류 무엇이든 자리는 반드시 반납
  }
});

export default router;
