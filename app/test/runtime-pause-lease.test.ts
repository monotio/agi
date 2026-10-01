import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuntimePauseLeaseAcquire,
  type RuntimePauseHost,
  type RuntimePauseLease,
} from "../src/engine/runtimePauseLease.ts";

/**
 * A deterministic engine host: pause/resume owners plus a worker identity and
 * a controllable state query. Owners survive only while `worker` is current —
 * a swap clears every owner exactly like the lifecycle's resetPauseOwners.
 */
function fakeHost(state: unknown = { cycles: 1 }) {
  const owners: string[] = [];
  const calls: string[] = [];
  let worker: object | null = { id: "worker-1" };
  const pending: ((value: unknown) => void)[] = [];
  const refused: ((error: unknown) => void)[] = [];
  const host: RuntimePauseHost = {
    getWorker: () => worker,
    pause(owner) {
      calls.push(`pause:${owner}`);
      owners.push(owner);
    },
    resume(owner) {
      calls.push(`resume:${owner}`);
      const index = owners.indexOf(owner);
      if (index >= 0) owners.splice(index, 1);
    },
    readState() {
      calls.push("query");
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        refused.push(reject);
      });
    },
  };
  let issued = 0;
  return {
    host,
    owners,
    calls,
    get worker() {
      return worker;
    },
    /** The lease acquire with a per-host deterministic token sequence. */
    acquire: createRuntimePauseLeaseAcquire(host, (owner) => `${owner}-${++issued}`),
    lastToken: () => `${issued}`,
    /** Lifecycle swap: identity changes and every owner is cleared. */
    swap() {
      worker = { id: "worker-2" };
      owners.length = 0;
    },
    vanish() {
      worker = null;
      owners.length = 0;
    },
    answer(value: unknown = state) {
      pending.splice(0).forEach((resolve) => resolve(value));
      refused.length = 0;
    },
    refuse(error: unknown = new Error("engine worker replaced")) {
      refused.splice(0).forEach((reject) => reject(error));
      pending.length = 0;
    },
  };
}

test("acquire posts its own pause before the state query and grants after the reply", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  assert.deepEqual(fake.calls, ["pause:preview-1", "query"]);
  fake.answer();
  const lease = await pendingLease;
  lease.release();
  assert.deepEqual(fake.calls, ["pause:preview-1", "query", "resume:preview-1"]);
  assert.deepEqual(fake.owners, []);
});

test("a pending acknowledgment does not grant the lease", async () => {
  const fake = fakeHost();
  let settled = false;
  let granted: RuntimePauseLease | null = null;
  const pendingLease = fake.acquire("preview").then(
    (lease) => {
      settled = true;
      granted = lease;
    },
    () => {
      settled = true;
    },
  );
  assert.equal(settled, false);
  fake.answer();
  await pendingLease;
  granted!.release();
  assert.equal(settled, true);
});

test("a refused query releases only the lease's own owner", async () => {
  const fake = fakeHost();
  fake.host.pause("foreign-owner");
  fake.calls.length = 0;
  const pendingLease = fake.acquire("preview");
  fake.refuse();
  await assert.rejects(pendingLease, /worker replaced/);
  assert.deepEqual(fake.calls, ["pause:preview-1", "query", "resume:preview-1"]);
  assert.deepEqual(fake.owners, ["foreign-owner"]);
});

test("a null state reply refuses acquisition and releases the hold", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  fake.answer(null);
  await assert.rejects(pendingLease, /state/);
  assert.deepEqual(fake.owners, []);
});

test("a worker swap during the awaited reply refuses and cannot resume the new worker", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  fake.swap();
  fake.refuse();
  await assert.rejects(pendingLease, /worker replaced/);
  // No resume went out: the swap already cleared the hold and the new worker
  // must never see a release for a pause it never received.
  assert.deepEqual(fake.calls, ["pause:preview-1", "query"]);
});

test("a swap that still resolves refuses the lease and leaves the new run untouched", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  fake.swap();
  fake.answer();
  await assert.rejects(pendingLease);
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("resume")),
    [],
  );
});

test("a late release after a worker swap cannot unpause the replacement run", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  fake.answer();
  const lease = await pendingLease;
  fake.swap();
  fake.host.pause("next-run-owner");
  lease.release();
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("resume")),
    [],
  );
  assert.deepEqual(fake.owners, ["next-run-owner"]);
});

test("release is idempotent", async () => {
  const fake = fakeHost();
  const pendingLease = fake.acquire("preview");
  fake.answer();
  const lease = await pendingLease;
  lease.release();
  lease.release();
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("resume")).length, 1);
});

test("a no-run acquire resolves to a lease that never pauses a later worker", async () => {
  const fake = fakeHost();
  fake.vanish();
  const lease = await fake.acquire("preview");
  assert.deepEqual(fake.calls, []);
  fake.swap();
  lease.release();
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.owners, []);
});

test("two leases hold independently and a foreign owner survives them", async () => {
  const fake = fakeHost();
  fake.host.pause("foreign-owner");
  const firstPending = fake.acquire("one");
  const secondPending = fake.acquire("two");
  fake.answer();
  fake.answer();
  const first = await firstPending;
  const second = await secondPending;
  assert.deepEqual(fake.owners, ["foreign-owner", "one-1", "two-2"]);
  first.release();
  assert.deepEqual(fake.owners, ["foreign-owner", "two-2"]);
  second.release();
  assert.deepEqual(fake.owners, ["foreign-owner"]);
});

test("a worker swap inside pause refuses without touching pause state", async () => {
  const fake = fakeHost();
  let swapped = false;
  const host: RuntimePauseHost = {
    ...fake.host,
    pause(owner) {
      fake.host.pause(owner);
      if (!swapped) {
        swapped = true;
        fake.swap();
      }
    },
  };
  const acquire = createRuntimePauseLeaseAcquire(host, (owner) => `${owner}-x`);
  await assert.rejects(acquire("preview"));
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("resume")),
    [],
  );
});

test("a pause failure refuses without a resume against an empty owner set", async () => {
  const fake = fakeHost();
  const host: RuntimePauseHost = {
    ...fake.host,
    pause() {
      throw new Error("worker post failed");
    },
  };
  const acquire = createRuntimePauseLeaseAcquire(host, (owner) => `${owner}-x`);
  await assert.rejects(acquire("preview"), /post failed/);
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("resume")),
    [],
  );
});
