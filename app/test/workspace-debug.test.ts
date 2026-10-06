import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceDebug, runningPosition } from "../src/studio/workspace/workspaceDebug.ts";
import { createExecutionDebugLink } from "../src/engine/executionDebugLink.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { createContainer } from "../../src/container/container.ts";
import { sha256Hex } from "../../src/crypto.ts";
import type {
  WorkerQueryFn,
  WorkerQueryType,
  WorkerControl,
} from "../src/worker/workerProtocol.ts";

function setup(leaveDuringAttach = false) {
  let creating = true;
  const source = "// inspect\nassignn(v40, 1);\nreturn;";
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": source },
    profileId: "2.936",
  });
  const model = new ProjectModel({
    documents: compiled.documents(),
    digest: sha256Hex,
    build: compiled,
  });
  const requests: { type: WorkerQueryType; extra: Record<string, unknown> }[] = [];
  const link = createExecutionDebugLink((async (type, extra) => {
    requests.push({ type, extra: structuredClone(extra ?? {}) });
    if (type === "debugAttach") {
      if (leaveDuringAttach) creating = false;
      return { epoch: 1, buildId: compiled.build.identity.buildId };
    }
    if (type === "debugConfigure") return { breakpoints: [] };
    return {};
  }) as WorkerQueryFn);
  const debug = createWorkspaceDebug({
    link,
    snapshot: () => model.capture(),
    profile: () => "2.936",
    reveal: () => {},
    stopped: () => {},
    current: () => creating,
  });
  return { debug, requests, compiled, link };
}
test("workspace breakpoint configuration crosses the real structured-clone boundary", async () => {
  const h = setup();
  await h.debug.toggle(0, 2);
  await h.debug.start();
  const configured = h.requests.find((request) => request.type === "debugConfigure");
  assert.deepEqual(configured?.extra["breakpoints"], [
    { id: "0:2", enabled: true, logic: 0, line: 2, mode: "statement" },
  ]);
  h.debug.dispose();
});
test("stopped source positions use only the captured build and its authored offset", async () => {
  const h = setup();
  assert.deepEqual(runningPosition(h.compiled.build, 0, 0, "action"), { logic: 0, line: 2 });
  assert.equal(runningPosition(h.compiled.build, 5, 0), null);
  await h.debug.start();
  h.link.handle({
    type: "debugStopped",
    epoch: 1,
    buildId: "another build",
    location: { logic: 0, pc: 0, kind: "action" },
  } as Extract<WorkerControl, { type: "debugStopped" }>);
  assert.equal(h.debug.position.value, null);
  assert.deepEqual(h.debug.usedValues.value, []);
  h.debug.dispose();
});

test("leaving Create during attach detaches the late MAIN session", async () => {
  const h = setup(true);
  await h.debug.start();
  assert.equal(h.debug.state.epoch, 0);
  assert.equal(
    h.requests.some((request) => request.type === "debugDetach"),
    true,
  );
  assert.equal(
    h.requests.some((request) => request.type === "debugConfigure"),
    false,
  );
  h.debug.dispose();
});

test("stepping stays active until a stop, continue or detach", async () => {
  const h = setup();
  await h.debug.start();
  const stop = {
    type: "debugStopped",
    epoch: 1,
    stopId: 1,
    buildId: h.compiled.build.identity.buildId,
    location: { logic: 0, pc: 0, kind: "action" },
  } as Extract<WorkerControl, { type: "debugStopped" }>;
  h.link.handle(stop);
  await h.debug.resume("over");
  assert.equal(h.link.stopped.value, null);
  assert.equal(h.debug.state.stepping, true);
  h.link.handle(stop);
  assert.equal(h.debug.state.stepping, false);
  await h.debug.resume("into");
  h.link.handle({ type: "debugDetached", epoch: 1 } as Extract<
    WorkerControl,
    { type: "debugDetached" }
  >);
  assert.equal(h.debug.state.stepping, false);
  h.link.handle(stop);
  await h.debug.resume("out");
  h.link.handle(stop);
  await h.debug.resume("continue");
  assert.equal(h.debug.state.stepping, false);
  h.debug.dispose();
});
