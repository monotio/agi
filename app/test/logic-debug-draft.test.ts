import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { createTestSession, type TestWorkerLike } from "../src/studio/logic/debug/testSession.ts";
import { createDebugWorkspace } from "../src/studio/logic/debug/logicDebugWorkspace.ts";
import { createStudioDraftSource } from "../src/studio/logic/debug/debugDraft.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

/**
 * The draft authority wired to a real stored project: the workspace freezes
 * the complete open draft through EditableProject.buildSelected, runs it on
 * a real engine, and binds breakpoints through the capture's own source maps.
 */

installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: (() => {
    const cache = new Map<string, string>();
    return {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, value: string) => void cache.set(key, value),
      removeItem: (key: string) => void cache.delete(key),
    };
  })(),
});

class FakeWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly ctx: WorkerContext;
  private now = 0;

  constructor() {
    this.ctx = createWorkerContext({
      control: (msg) => this.emit(msg),
      presentation: (msg) => this.emit(msg),
      now: () => this.now,
      seedWord: () => 0x1234,
    });
    this.ctx.host = createEngineHost(this.ctx);
  }

  private emit(msg: WorkerOutbound): void {
    if (!this.terminated) this.onmessage?.({ data: msg });
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    onWorkerMessage(this.ctx, message);
    this.ctx.fns.stopTimers();
  }

  terminate(): void {
    this.terminated = true;
    this.ctx.fns.stopTimers();
  }

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.now += 1000 / 60;
      this.ctx.fns.hostTick();
    }
  }
}

test("a stored starter project freezes, runs, and stops on an authored line", async (t) => {
  const prepared = prepareLocalProject({ title: "ws-debug", kind: "starter" });
  await prepared.save();
  const ws = await openEditableProject(prepared.projectId);
  const workers: FakeWorker[] = [];
  const workspace = createDebugWorkspace({
    draft: createStudioDraftSource(() => ws),
    acquirePauseLease: () => ({ release() {} }),
    createSession: (options) => createTestSession(options),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  t.after(() => workspace.dispose());

  // A source breakpoint on the room's `if (said("look"))` statement.
  workspace.toggleBreakpoint({ logic: 1, line: 24 });
  const run = await workspace.test();
  assert.equal(workers.length, 1);
  assert.equal(workspace.state.buildId, run.buildId);
  assert.equal(workspace.state.profileId, "2.936");
  assert.ok(workspace.state.frozenSources["0"]!.includes("submit.menu"));

  // Stop-on-entry is an honest idle park — the engine has not reached a
  // statement boundary, so there is no authored location to claim.
  assert.equal(workspace.state.phase, "stopped");
  assert.equal(workspace.state.stop!.cause.type, "wait");
  // A local keeps the narrowing off the property for the reads below.
  const entry = workspace.state.stopLocation;
  assert.ok(entry === null);

  await workspace.continueRun();
  workers[0]!.tick(30);
  assert.equal(workspace.state.phase, "stopped");
  const at = workspace.state.stopLocation;
  assert.ok(at, "the breakpoint stop should resolve an authored line");
  assert.equal(at.key, "logic:1");
  assert.equal(await workspace.evaluate("v0"), 1, "the starter entered room 1");
});

test("a draft edit stays out of the frozen run; the stale flag is version-exact", async (t) => {
  const prepared = prepareLocalProject({ title: "ws-debug-stale", kind: "blank" });
  await prepared.save();
  const ws = await openEditableProject(prepared.projectId);
  const workers: FakeWorker[] = [];
  const workspace = createDebugWorkspace({
    draft: createStudioDraftSource(() => ws),
    acquirePauseLease: () => ({ release() {} }),
    createSession: (options) => createTestSession(options),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  t.after(() => workspace.dispose());

  await workspace.test();
  assert.equal(workspace.state.stale, false);

  const snapshot = ws.draft.capture();
  ws.draft.edit(
    "logic:1",
    "// Room 1 — altered\nif (isset(f5)) {\n  show.pic();\n}\nreturn;",
    snapshot.version("logic:1"),
  );
  workspace.noteDraftChanged();
  assert.equal(workspace.state.stale, true);
  assert.equal(workspace.isDocStale("logic:1"), true);
  assert.equal(workspace.isDocStale("logic:0"), false);
  assert.ok(
    workspace.frozenSource("logic:1")!.includes("accept.input"),
    "the frozen build keeps the original source",
  );
});

/** A fresh stored starter project + workspace wired to real workers. */
async function draftHarness(
  t: { after(fn: () => void): void },
  title: string,
): Promise<{
  ws: Awaited<ReturnType<typeof openEditableProject>>;
  workspace: ReturnType<typeof createDebugWorkspace>;
  workers: FakeWorker[];
}> {
  const prepared = prepareLocalProject({ title, kind: "starter" });
  await prepared.save();
  const ws = await openEditableProject(prepared.projectId);
  const workers: FakeWorker[] = [];
  const workspace = createDebugWorkspace({
    draft: createStudioDraftSource(() => ws),
    acquirePauseLease: () => ({ release() {} }),
    createSession: (options) => createTestSession(options),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  t.after(() => workspace.dispose());
  return { ws, workspace, workers };
}

test("removing a document marks the frozen build stale", async (t) => {
  const { ws, workspace } = await draftHarness(t, "ws-debug-remove");
  await workspace.test();
  assert.equal(workspace.state.stale, false);

  ws.draft.edit("logic:1", null, ws.draft.capture().version("logic:1"));
  workspace.noteDraftChanged();
  assert.equal(workspace.state.stale, true, "the draft lost a document the build pinned");
  assert.equal(workspace.isDocStale("logic:1"), true);
  assert.ok(
    workspace.frozenSource("logic:1")!.includes("accept.input"),
    "the pinned build keeps the removed source",
  );
});

test("retyping identical content is a draft no-op and stays unstale", async (t) => {
  const { ws, workspace } = await draftHarness(t, "ws-debug-noop");
  await workspace.test();

  const before = ws.draft.capture();
  const content = before.read("logic:1")!.content;
  assert.equal(typeof content, "string");
  ws.draft.edit("logic:1", content, before.version("logic:1"));
  workspace.noteDraftChanged();
  // The draft only assigns versions on real content moves, so a byte-identical
  // rewrite keeps the pinned version — staleness is content-exact, not touch-exact.
  assert.equal(ws.draft.capture().version("logic:1"), before.version("logic:1"));
  assert.equal(workspace.state.stale, false);
});

test("undo restores content but moves the version — the run stays stale", async (t) => {
  const { ws, workspace } = await draftHarness(t, "ws-debug-undo");
  await workspace.test();
  assert.equal(workspace.state.stale, false);

  const base = ws.draft.capture();
  const proposal = ws.draft.propose(base, "touch room one", [
    { key: "logic:1", content: "// touched\nreturn;" },
  ]);
  const transaction = ws.draft.apply(proposal);
  workspace.noteDraftChanged();
  assert.equal(workspace.state.stale, true);

  ws.draft.undo(transaction.id);
  workspace.noteDraftChanged();
  const restored = ws.draft.capture().read("logic:1")!.content;
  assert.ok(workspace.frozenSource("logic:1")!.includes("accept.input"));
  assert.ok(typeof restored === "string" && restored.includes("accept.input"));
  // Undo is a real revision: content matches the frozen build but the pinned
  // version moved, so the honest answer stays stale until the next Test.
  assert.equal(workspace.state.stale, true);
});

test("a byte-only logic joins the set stale and fabricates no source", async (t) => {
  const { ws, workspace } = await draftHarness(t, "ws-debug-bytes");
  const compiled = compileProjectLogic("return;", {
    profile: PROFILES["2.936"],
    dictionary: new Map(),
    bindings: {},
  });
  const payload = new Uint8Array(compiled.assembly.payload);

  // Freeze the draft that already holds the imported-byte logic — the complete
  // document set at capture includes it, so a matching freeze is not stale.
  ws.draft.edit("logic:9", payload, 0);
  const before = createStudioDraftSource(() => ws).captureTestBuild();
  assert.equal(before.sources["9"], undefined, "byte content has no authored source");
  const entry = before.capture.logics.find((logic) => logic.num === 9);
  assert.ok(entry, "the byte logic reached the compiled image");
  assert.equal(entry.authored, undefined, "no source is fabricated for it");

  await workspace.test();
  assert.equal(workspace.state.stale, false);

  ws.draft.edit(
    "logic:9",
    new Uint8Array([...payload, 0xff]),
    ws.draft.capture().version("logic:9"),
  );
  workspace.noteDraftChanged();
  assert.equal(workspace.state.stale, true, "byte documents move the version too");
});

test("run-to-cursor refuses a document the draft moved past", async (t) => {
  const { ws, workspace } = await draftHarness(t, "ws-debug-runto");
  await workspace.test();
  const ok = await workspace.runToCursor("logic:1", 24);
  assert.equal(ok.ok, true);

  const snapshot = ws.draft.capture();
  ws.draft.edit("logic:1", "// moved\nreturn;", snapshot.version("logic:1"));
  workspace.noteDraftChanged();
  const refused = await workspace.runToCursor("logic:1", 24);
  assert.equal(refused.ok, false, "a stale line cannot bind to the frozen map");
  assert.match(refused.error ?? "", /moved|latest draft/i);
});
