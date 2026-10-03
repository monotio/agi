import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import {
  createTestSession,
  type TestPauseLease,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";

test("Test captures nested breakpoint and watchpoint options before awaiting its park", async () => {
  const container = createContainer();
  const source = "assignn(v40, 7); return;";
  container.putResource(
    "logic",
    0,
    compileProjectLogic(source, {
      profile: PROFILES["2.411"],
      dictionary: new Map(),
      bindings: {},
    }).assembly.payload,
  );
  let grant!: (lease: TestPauseLease) => void;
  const park = new Promise<TestPauseLease>((resolve) => {
    grant = resolve;
  });
  const posted: WorkerInbound[] = [];
  const worker: TestWorkerLike = {
    onmessage: null as ((event: { data: WorkerOutbound }) => void) | null,
    postMessage(message) {
      // A real Worker captures the message at post time through structured clone.
      posted.push(structuredClone(message));
    },
    terminate() {},
  };
  const session = createTestSession({
    acquirePauseLease: () => park,
    createWorker: () => worker,
  });
  const hit = { kind: "every" as const, count: 2 };
  const segment = { type: "literal" as const, text: "reviewed log" };
  const target = { kind: "variable" as const, index: 40 };
  const admission = session.start(
    {
      profile: "2.411",
      files: Object.fromEntries(container.files),
      sources: { "0": source },
      sourceBindings: {},
    },
    {
      breakpoints: [
        {
          id: "reviewed",
          enabled: true,
          logic: 0,
          line: 1,
          mode: "statement",
          hit,
          log: { segments: [segment] },
        },
      ],
      watchpoints: [{ id: "watched", enabled: true, target }],
    },
  );
  const settled = admission.catch(() => undefined);
  try {
    assert.equal(posted.length, 0, "no worker boot precedes the park");
    hit.count = 99;
    segment.text = "changed after start";
    target.index = 41;
    grant({ release() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const boot = posted.find((message) => message.type === "boot");
    assert.ok(boot?.type === "boot" && boot.frozenTest);
    assert.deepEqual(
      {
        hit: boot.frozenTest.breakpoints?.[0]?.hit,
        log: boot.frozenTest.breakpoints?.[0]?.log,
        target: boot.frozenTest.watchpoints?.[0]?.target,
      },
      {
        hit: { kind: "every", count: 2 },
        log: { segments: [{ type: "literal", text: "reviewed log" }] },
        target: { kind: "variable", index: 40 },
      },
      "the admitted debugger plan must remain the plan offered at start",
    );
  } finally {
    session.close();
    await settled;
  }
});
