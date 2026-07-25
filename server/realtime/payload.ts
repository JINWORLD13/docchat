// 소켓 페이로드에서 값을 안전하게 꺼내는 도구.
//
// 왜 따로 두나: 이 프로젝트에서 가장 비싸게 배운 것이 여기 있다.
//
// ClientToServer 타입(types.ts)은 컴파일 타임에만 존재한다. 선을 타고 실제로
// 도착하는 값은 null이든 숫자든 배열이든 무엇이든 될 수 있고, 타입은 그걸
// 하나도 막아주지 않는다. 그런데 핸들러는 인자를 바로 구조분해하고 있었다.
//
//   socket.on("message", ({ text }) => ...)
//
// payload가 null이면 구조분해 그 자리에서 TypeError가 난다. Socket.IO는
// 리스너를 process.nextTick 안에서 try/catch 없이 부르므로, 그 예외는
// uncaughtException이 되어 프로세스를 통째로 죽인다. 즉 브라우저 콘솔에서
//
//   socket.emit("message")
//
// 한 줄이면 접속자 전원의 연결이 끊겼다. hello·join·image도 같았다.
//
// 그래서 경계에서 모양부터 확인한다. 타입은 우리 코드끼리의 약속이고,
// 신뢰 경계 밖에서 오는 값은 약속의 대상이 아니다.

// 문자열 필드를 꺼낸다. 없거나 문자열이 아니면 빈 문자열.
//
// hasOwn을 쓰는 이유: 그냥 payload[key]로 읽으면 프로토타입에서 상속된 값도
// 잡힌다. 이 값은 클라이언트가 보낸 JSON에서 나오므로, "우리가 실제로 받은
// 필드"만 보는 게 맞다.
export function readString(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null) return "";
  if (!Object.hasOwn(payload, key)) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
