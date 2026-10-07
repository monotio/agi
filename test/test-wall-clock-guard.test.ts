import assert from "node:assert/strict";
import { test } from "node:test";
import { unmarkedTestWaits } from "../scripts/check-test-wall-clock.ts";

test("wall-clock reasons apply to the wait's line and the line immediately above", () => {
  assert.deepEqual(unmarkedTestWaits("await sleep(100);"), [1]);
  assert.deepEqual(
    unmarkedTestWaits('const reason = "// wall-clock: native window";\nawait sleep(100);'),
    [2],
  );
  assert.deepEqual(
    unmarkedTestWaits("await page.waitForTimeout(100); // wall-clock: native window"),
    [],
  );
  assert.deepEqual(unmarkedTestWaits("// wall-clock: native window\nawait sleep(100);"), []);
  assert.deepEqual(unmarkedTestWaits("// wall-clock: native window\n\nawait sleep(100);"), [3]);
  assert.deepEqual(
    unmarkedTestWaits("await sleep(100);\n// wall-clock: native window\nawait sleep(100);"),
    [1],
  );
});

test("promise timers and timer import aliases need a reason; safety deadlines and yields stay available", () => {
  assert.deepEqual(
    unmarkedTestWaits("const settle = () => new Promise<void>(r => setTimeout(r, 0));"),
    [1],
  );
  assert.deepEqual(
    unmarkedTestWaits(
      'import { setTimeout as delay } from "node:timers/promises";\nawait delay(20);',
    ),
    [2],
  );
  assert.deepEqual(
    unmarkedTestWaits(
      "const timer = setTimeout(fail, 100);\nawait scheduler.yield();\nclock.advance(100);",
    ),
    [],
  );
});

for (const module of ["node:timers/promises", "timers/promises", "node:timers", "timers"]) {
  test(`${module} namespace promise timers need a wall-clock reason`, () => {
    const call = module.endsWith("/promises")
      ? "timers.setTimeout(20)"
      : "timers.promises.setTimeout(20)";
    assert.deepEqual(
      unmarkedTestWaits(`import * as timers from "${module}";\nawait ${call};`),
      [2],
    );
    assert.deepEqual(
      unmarkedTestWaits(
        `import * as timers from "${module}";\n// wall-clock: failure deadline\nawait ${call};`,
      ),
      [],
    );
    assert.deepEqual(
      unmarkedTestWaits('import * as other from "unrelated";\nawait other.setTimeout(20);'),
      [],
    );
  });
}
