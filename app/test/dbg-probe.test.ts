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
  readonly posts: WorkerInbound[] = [];
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
    this.posts.push(message);
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

test("probe: run-to-cursor after a set-values stop on a real starter", async (t) => {
  const prepared = prepareLocalProject({ title: "probe-runto", kind: "starter" });
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

  const lookLine =
    String(ws.draft.capture().read("logic:1")!.content)
      .split("\n")
      .findIndex((line) => line.startsWith('if (said("look"))')) + 1;
  assert.ok(lookLine > 0);
  workspace.toggleBreakpoint({ logic: 1, line: lookLine });
  await workspace.test();
  await workspace.continueRun();
  workers[0]!.tick(30);
  assert.equal(workspace.state.phase, "stopped");

  await workspace.setValues({ vars: [[60, 5]] });
  assert.equal(workspace.state.phase, "stopped");

  const listenLine =
    String(ws.draft.capture().read("logic:1")!.content)
      .split("\n")
      .findIndex((line) => line.startsWith('if (said("listen"))')) + 1;
  const verdict = await workspace.runToCursor("logic:1", listenLine);
  console.log("verdict", JSON.stringify(verdict));
  const posted = workers[0]!.posts.find((m) => m.type === "debugRunTo");
  console.log("posted", JSON.stringify(posted));
  workers[0]!.tick(60);
  await new Promise((r) => setTimeout(r, 0));
  console.log("phase", workspace.state.phase);
  console.log("reasons", JSON.stringify(workspace.state.stop?.reasons));
  console.log("stopLocation", JSON.stringify(workspace.state.stopLocation));
});
