import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerQueries } from "../src/workerQueries.ts";

function createMockWorker(): Worker {
  const posted: unknown[] = [];
  return {
    postMessage(data: unknown) {
      posted.push(data);
    },
  } as unknown as Worker;
}

test("workerQueries rejects immediately if worker is null", async () => {
  const q = createWorkerQueries();
  await assert.rejects(
    q.query(() => null, "test"),
    /no engine running/,
  );
});

test("workerQueries dispatches query and resolves on matching resolveQuery", async () => {
  const q = createWorkerQueries();
  const worker = createMockWorker();
  const promise = q.query<string>(() => worker, "exportFiles");

  assert.equal(q.resolveQuery(1, "file-payload"), true);
  const result = await promise;
  assert.equal(result, "file-payload");

  // Duplicate resolution returns false
  assert.equal(q.resolveQuery(1, "ignored"), false);
});

test("workerQueries times out if not resolved", async () => {
  const q = createWorkerQueries();
  const worker = createMockWorker();
  await assert.rejects(
    q.query(() => worker, "slowQuery", {}, 20),
    /slowQuery timed out/,
  );
});

test("workerQueries drainPendingQueries aborts all in-flight queries", async () => {
  const q = createWorkerQueries();
  const worker = createMockWorker();
  const p1 = q.query(() => worker, "q1");
  const p2 = q.query(() => worker, "q2");

  q.drainPendingQueries(new Error("Engine shut down"));
  await assert.rejects(p1, /Engine shut down/);
  await assert.rejects(p2, /Engine shut down/);
});
