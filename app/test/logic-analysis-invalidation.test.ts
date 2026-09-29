import assert from "node:assert/strict";
import { test } from "node:test";
import { LogicAnalysisClient } from "../src/studio/logic/analysisClient.ts";
import { createLogicAnalysisService } from "../src/studio/logic/analysisService.ts";
import type {
  LogicAnalysisProject,
  LogicAnalysisReply,
  LogicAnalysisRequest,
} from "../src/studio/logic/analysisProtocol.ts";

class FakeWorker {
  onmessage: ((event: MessageEvent<LogicAnalysisReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: LogicAnalysisRequest[] = [];
  terminated = false;
  analyze = createLogicAnalysisService();
  postMessage(request: LogicAnalysisRequest) {
    this.requests.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  reply(index = 0) {
    this.onmessage?.({
      data: this.analyze(this.requests[index]!),
    } as MessageEvent<LogicAnalysisReply>);
  }
}

function project(source = "set(door); return;", revision = 1): LogicAnalysisProject {
  return {
    revision,
    profileId: "2.936",
    words: [["open", 100]],
    bindings: { door: { num: 50 } },
    documents: { "logic:1": { version: revision, source } },
  };
}

test("an invalid context rejects pending requests with its own error and clears the snapshot", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project());
  const pending = client.request("logic:1", { method: "diagnostics" });
  const rejected = assert.rejects(pending, /bindings document|context/i);
  client.invalidateContext("The bindings document cannot be read.");
  await rejected;
  // No consulted snapshot: every request now fails until the next setProject.
  await assert.rejects(
    client.request("logic:1", { method: "diagnostics" }),
    /No authored logic document/,
  );
  // Invalidation is not a crash: the worker stays alive for the next snapshot.
  assert.equal(worker.terminated, false);
  client.dispose();
});

test("a reply captured before invalidation cannot resolve a newer request", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project());
  const stale = client.request("logic:1", { method: "hoverAt", offset: 4 });
  const staleRejected = assert.rejects(stale, /bindings document|context/i);
  client.invalidateContext("The bindings document cannot be read.");
  await staleRejected;

  // The context parses again: a fresh snapshot takes over on a new epoch.
  client.setProject(project("set(door); return;", 3));
  const current = client.request("logic:1", { method: "hoverAt", offset: 4 });
  let settled = false;
  void current.then(
    () => (settled = true),
    () => (settled = true),
  );
  // The old request's reply arriving late must not resolve the new request.
  worker.reply(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  worker.reply(1);
  assert.equal((await current)?.text, "#define door 50");
  client.dispose();
});

test("invalidation is restartable: a fixed document restores answers", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project());
  client.invalidateContext("The words document cannot be read.");
  client.setProject(project());
  const diagnostics = client.request("logic:1", { method: "diagnostics" });
  worker.reply(0);
  assert.deepEqual(await diagnostics, { diagnostics: [], generatedDiagnostics: [] });
  client.dispose();
});
