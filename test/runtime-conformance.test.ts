import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { runtimeResults } from "../scripts/runtime-conformance.ts";
import { compareBundles } from "../scripts/conformance.ts";

function files() {
  const c = createContainer();
  c.putResource("picture", 0, Uint8Array.of(255));
  c.putResource(
    "logic",
    0,
    assembleLogic(
      'if(!isset(f200)){set(f200);assignn(v10,2);assignn(v60,0);load.pic(v60);draw.pic(v60);show.pic();assignn(v21,2);print("Timed.");assignn(v200,42);}random(0,255,v201);return;',
      { dictionary: new Map() },
    ).payload,
  );
  return c.files;
}

test("runtime conformance records repeatable timed execution and native save/restore checkpoints", () => {
  const scenario = {
    suiteId: "timed-roundtrip",
    profile: "2.936",
    seed: 17,
    steps: [
      { advance: 100 },
      { checkpoint: "message" },
      { advance: 1000 },
      { checkpoint: "after" },
      { save: "slot" },
      { advance: 1000 },
      { restore: "slot" },
      { checkpoint: "restored" },
    ],
  };
  const result = runtimeResults(files(), scenario);
  assert.deepEqual(compareBundles(result, runtimeResults(files(), scenario)), []);
  const message = result.cases.find((c) => c.id === "message/state")!.values!;
  const after = result.cases.find((c) => c.id === "after/state")!.values!;
  const restored = result.cases.find((c) => c.id === "restored/state")!.values!;
  assert.equal(message["modal"], "print");
  assert.equal(after["modal"], null);
  assert.equal((after["variables"] as number[])[200], 42);
  assert.equal((restored["variables"] as number[])[200], 42);
  assert.equal((restored["variables"] as number[])[201], (after["variables"] as number[])[201]);
  assert.ok(result.cases.some((c) => c.id === "after/visual" && c.frame?.sha256.length === 64));
  assert.ok(result.cases.some((c) => c.id === "after/priority"));
  assert.ok(
    !JSON.stringify(result).includes("Timed."),
    "comparison artifacts contain hashes rather than game message text",
  );
  const mismatch = structuredClone(result);
  (mismatch.cases.find((c) => c.id === "after/state")!.values!["variables"] as number[])[200] = 41;
  assert.ok(compareBundles(result, mismatch).length);
});

test("runtime scenarios reject ambiguous, unbounded and impossible steps", () => {
  for (const steps of [
    [{ advance: -1 }],
    [{ advance: Infinity }],
    [{ advance: 100, checkpoint: "x" }],
    [{ checkpoint: "x" }, { checkpoint: "x" }],
    [{ restore: "absent" }],
    [{ advance: 100 }, { save: "modal" }],
    [{ key: 65536 }],
    [{ unknown: 1 }],
  ]) {
    assert.throws(() => runtimeResults(files(), { suiteId: "invalid", profile: "2.936", steps }));
  }
});
