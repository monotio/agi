import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("the tests worker is checked with worker globals and excluded from browser globals", () => {
  const worker = readFileSync(new URL("../tsconfig.worker.json", import.meta.url), "utf8");
  const app = JSON.parse(
    readFileSync(new URL("../tsconfig.app.json", import.meta.url), "utf8"),
  ) as { exclude: string[] };
  assert.ok(worker.includes('"src/studio/tests.worker.ts"'));
  assert.ok(app.exclude.includes("src/studio/tests.worker.ts"));
});
