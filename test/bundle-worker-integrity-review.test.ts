import assert from "node:assert/strict";
import { test } from "node:test";
import { workerStaticClosure, type GraphChunk } from "../scripts/check-bundle-budget.ts";

function chunk(file: string, imports: readonly string[] = []): GraphChunk {
  return {
    file,
    isEntry: file === "assets/engine.worker.js",
    imports,
    dynamicImports: [],
    css: [],
    modules: [],
  };
}

test("worker measurement refuses a graph that lost its startup entry", () => {
  assert.throws(
    () => workerStaticClosure([chunk("assets/shared.js")], "assets/engine.worker.js"),
    /engine\.worker\.js/,
    "a missing entry cannot be measured as zero startup bytes",
  );
});

test("worker measurement refuses a graph that lost a required static chunk", () => {
  assert.throws(
    () =>
      workerStaticClosure(
        [chunk("assets/engine.worker.js", ["assets/shared.js"])],
        "assets/engine.worker.js",
      ),
    /shared\.js/,
    "an absent static dependency cannot silently disappear from the byte total",
  );
});
