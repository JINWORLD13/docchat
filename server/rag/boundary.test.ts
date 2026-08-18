// 코어 경계 테스트.
//
// "코어는 express·pg·Gemini를 모른다"는 건 이 구조 전체가 서 있는 전제인데,
// 주석으로만 적어두면 지켜지는지 아무도 모른다. 실제로 깨지는 방식은 늘 사소하다 —
// 급할 때 engine.ts에서 db.ts를 한 줄 import하면 그 순간 코어는 Postgres 없이는
// 못 도는 코드가 되고, 그 사실은 다른 앱에 옮기려다 몇 달 뒤에 발견된다.
//
// 그래서 사람의 규율 대신 테스트로 막는다. 이 테스트가 깨지면 설계가 깨진 것이다.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

// 코어가 알면 안 되는 것들. 각각 특정 전송 방식·저장소·벤더에 코어를 묶는다.
const FORBIDDEN = ["express", "pg", "@google/genai", "socket.io", "multer", "dotenv"];

// import ... from "X" / export ... from "X" 의 X만 뽑는다.
// 주석 안에 이름이 적혀 있는 건 잡히지 않는다(실제로 그런 주석이 있다).
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

function coreFiles(): string[] {
  return readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

test("코어는 프레임워크·DB·LLM 벤더를 import하지 않는다", () => {
  for (const file of coreFiles()) {
    const specs = importsOf(readFileSync(join(CORE_DIR, file), "utf8"));
    for (const spec of specs) {
      assert.ok(
        !FORBIDDEN.includes(spec),
        `rag/${file}이 ${spec}에 의존한다. 그 의존은 adapters/ 쪽에 있어야 한다.`
      );
    }
  }
});

test("코어는 자기 디렉터리 밖의 앱 코드를 참조하지 않는다", () => {
  for (const file of coreFiles()) {
    const specs = importsOf(readFileSync(join(CORE_DIR, file), "utf8"));
    for (const spec of specs) {
      assert.ok(
        !spec.startsWith("../"),
        `rag/${file}이 ${spec}을 참조한다. 의존 방향은 앱 → 코어 한쪽이어야 한다.`
      );
    }
  }
});

test("경계 검사기 자체가 동작한다", () => {
  // 위 두 테스트가 항상 통과하기만 하는 껍데기가 아니라는 확인.
  // (import 문을 못 뽑고 있으면 어떤 위반도 영영 못 잡는다.)
  const sample = `import { Router } from "express";\nimport type { A } from "../db.ts";\n`;
  assert.deepEqual(importsOf(sample), ["express", "../db.ts"]);

  // 여러 줄에 걸친 import도 잡아야 한다 — 코어에서 실제로 쓰는 모양이다.
  const multiline = `import {\n  type Foo,\n  type Bar,\n} from "./types.ts";\n`;
  assert.deepEqual(importsOf(multiline), ["./types.ts"]);
});
