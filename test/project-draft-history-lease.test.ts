import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DraftBusyError,
  ProjectDraft,
  type DraftHistoryLease,
  type DraftKeepAdmission,
} from "../src/authoring/projectDraft.ts";

function draft() {
  return new ProjectDraft({ "logic:1": "return;" });
}

function revisionOf(d: ProjectDraft): number {
  return d.capture().revision;
}

function busy(error: unknown, reason?: string) {
  assert.ok(error instanceof DraftBusyError, `expected DraftBusyError, got ${String(error)}`);
  if (reason !== undefined) assert.equal(error.reason, reason);
}

test("an ordinary edit refuses while a native history lease is held, including a no-op", () => {
  const d = draft();
  const snapshot = d.capture();
  const lease = d.acquireHistoryMutation(snapshot.revision);
  const before = d.capture();
  assert.throws(
    () => d.edit("logic:1", "changed;", snapshot.version("logic:1")),
    (e) => {
      busy(e, "native-history");
      return true;
    },
  );
  // No-op path is guarded too: identical content cannot slip past exclusion.
  assert.throws(
    () => d.edit("logic:1", "return;", snapshot.version("logic:1")),
    (e) => {
      busy(e, "native-history");
      return true;
    },
  );
  d.releaseHistoryMutation(lease);
  assert.equal(revisionOf(d), before.revision);
  d.edit("logic:1", "changed;", snapshot.version("logic:1"));
  assert.notEqual(revisionOf(d), before.revision);
});

test("transactions refuse under a lease without consuming proposal or flipping flags", () => {
  const d = draft();
  const base = d.capture();
  const proposal = d.propose(base, "guided", [
    { key: "logic:1", content: "a" },
    { key: "words", content: null },
  ]);
  const applied = d.apply(proposal);
  const second = d.propose(d.capture(), "second", [{ key: "logic:1", content: "b" }]);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  assert.throws(
    () => d.undo(applied.id),
    (e) => (busy(e, "native-history"), true),
  );
  assert.throws(
    () => d.apply(second),
    (e) => (busy(e, "native-history"), true),
  );
  // No transaction state moved: the applied one still undoes and the
  // proposal was never consumed — both work after release.
  d.releaseHistoryMutation(lease);
  assert.equal(d.capture().read("logic:1")?.content, "a");
  const secondTx = d.apply(second);
  assert.equal(d.capture().read("logic:1")?.content, "b");
  assert.throws(() => d.apply(second), /already applied/);
  d.undo(secondTx.id);
  d.undo(applied.id);
  assert.equal(d.capture().read("logic:1")?.content, "return;");
});

test("ordinary redo and acknowledgeKept refuse under a lease", () => {
  const d = draft();
  const proposal = d.propose(d.capture(), "guided", [{ key: "logic:1", content: "a" }]);
  const applied = d.apply(proposal);
  d.undo(applied.id);
  const selection = d.select(["logic:1"]);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  assert.throws(
    () => d.redo(applied.id),
    (e) => (busy(e, "native-history"), true),
  );
  assert.throws(
    () => d.acknowledgeKept(selection),
    (e) => (busy(e, "native-history"), true),
  );
  // The undo restored the kept baseline: nothing is dirty, and nothing moved.
  assert.deepEqual(d.dirtyKeys(), []);
  d.releaseHistoryMutation(lease);
  assert.equal(d.acknowledgeKept(selection), true);
  d.redo(applied.id);
  assert.equal(d.capture().read("logic:1")?.content, "a");
});

test("the live lease authorizes receipt reversal; plain calls and wrong tokens refuse", () => {
  const d = draft();
  d.edit("logic:1", "step one;", 1);
  const second = d.edit("logic:1", "step two;", 2);
  assert.ok(second);
  const foreign = draft();
  const foreignLease = foreign.acquireHistoryMutation(foreign.capture().revision);
  const forged = Object.freeze({ kind: "native-history" }) as DraftHistoryLease;
  const lease = d.acquireHistoryMutation(revisionOf(d));
  assert.throws(
    () => d.reverseEdits([second]),
    (e) => (busy(e, "native-history"), true),
  );
  assert.throws(() => d.reverseEdits([second], forged), /belongs to another workspace/);
  assert.throws(() => d.reverseEdits([second], foreignLease), /belongs to another workspace/);
  assert.equal(revisionOf(d), 3);
  d.reverseEdits([second], lease);
  assert.equal(d.capture().read("logic:1")?.content, "step one;");
  d.reapplyEdits([second], lease);
  assert.equal(d.capture().read("logic:1")?.content, "step two;");
  d.releaseHistoryMutation(lease);
  foreign.releaseHistoryMutation(foreignLease);
});

test("cancel revokes privileged writes while exclusion lasts until release", () => {
  const d = draft();
  const receipt = d.edit("logic:1", "a", 1);
  assert.ok(receipt);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  d.cancelHistoryMutation(lease);
  assert.throws(
    () => d.reverseEdits([receipt], lease),
    (e) => (busy(e, "native-history"), true),
  );
  // Exclusion is still held: ordinary writers and a second lease refuse.
  assert.throws(
    () => d.edit("logic:1", "b", 2),
    (e) => (busy(e, "native-history"), true),
  );
  assert.throws(
    () => d.acquireHistoryMutation(revisionOf(d)),
    (e) => (busy(e, "native-history"), true),
  );
  d.releaseHistoryMutation(lease);
  // The released token no longer authorizes; the receipt is still usable.
  assert.throws(() => d.reverseEdits([receipt], lease), /already released/);
  d.reverseEdits([receipt]);
  assert.equal(d.capture().read("logic:1")?.content, "return;");
});

test("cancel and release are idempotent for their own token only", () => {
  const d = draft();
  const lease = d.acquireHistoryMutation(revisionOf(d));
  d.cancelHistoryMutation(lease);
  d.cancelHistoryMutation(lease);
  d.releaseHistoryMutation(lease);
  d.releaseHistoryMutation(lease);
  const forged = Object.freeze({ kind: "native-history" }) as DraftHistoryLease;
  assert.throws(() => d.cancelHistoryMutation(forged), /belongs to another workspace/);
  assert.throws(() => d.releaseHistoryMutation(forged), /belongs to another workspace/);
  const other = draft();
  const otherLease = other.acquireHistoryMutation(other.capture().revision);
  assert.throws(() => d.releaseHistoryMutation(otherLease), /belongs to another workspace/);
  other.releaseHistoryMutation(otherLease);
});

test("acquisition pins the expected revision and refuses stale callers", () => {
  const d = draft();
  assert.throws(() => d.acquireHistoryMutation(99), /Stale revision/);
  const lease = d.acquireHistoryMutation(1);
  assert.throws(
    () => d.acquireHistoryMutation(1),
    (e) => (busy(e, "native-history"), true),
  );
  d.releaseHistoryMutation(lease);
  d.releaseHistoryMutation(d.acquireHistoryMutation(1));
});

test("receipt validation still precedes mutation under a valid lease", () => {
  const d = draft();
  d.edit("logic:1", "a", 1);
  const second = d.edit("logic:1", "b", 2);
  assert.ok(second);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  // Wrong states and duplicated handles refuse atomically even under the lease.
  assert.throws(() => d.reverseEdits([second, second], lease), /Duplicate edit receipt/);
  assert.throws(() => d.reapplyEdits([second], lease), /not in the reversed state/);
  d.reverseEdits([second], lease);
  // A reversed receipt cannot reverse twice.
  assert.throws(() => d.reverseEdits([second], lease), /not in the applied state/);
  d.reapplyEdits([second], lease);
  d.releaseHistoryMutation(lease);
});

test("a net-zero group still restores its origin under a lease", () => {
  const d = draft();
  const tx = d.apply(d.propose(d.capture(), "t", [{ key: "logic:1", content: "gone;" }]));
  d.undo(tx.id);
  const snapshot = d.capture();
  const insert = d.edit("logic:1", "return;x", snapshot.version("logic:1"));
  const remove = d.edit("logic:1", "return;", d.capture().version("logic:1"));
  assert.ok(insert && remove);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  // Bytes equal the pre-group content; only the verified origin must move.
  d.reverseEdits([insert, remove], lease);
  assert.equal(d.capture().read("logic:1")?.content, "return;");
  d.releaseHistoryMutation(lease);
  d.redo(tx.id); // the restored origin releases the transaction's redo arm
  assert.equal(d.capture().read("logic:1")?.content, "gone;");
});

test("a pending Keep admission blocks history acquisition while typing stays free", () => {
  const d = draft();
  d.edit("logic:1", "a", 1);
  const selection = d.select(["logic:1"]);
  const admission = d.admitKeep(selection);
  assert.throws(
    () => d.acquireHistoryMutation(revisionOf(d)),
    (e) => (busy(e, "keep-pending"), true),
  );
  // The reservation is not an exclusive lock: ordinary typing still lands.
  d.edit("logic:1", "b", 2);
  assert.deepEqual(d.dirtyKeys(), ["logic:1"]);
  d.finishKeepAdmission(admission);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  d.releaseHistoryMutation(lease);
});

test("admissions queue: every unresolved one must settle before history runs", () => {
  const d = draft();
  d.edit("logic:1", "a", 1);
  const first = d.admitKeep(d.select(["logic:1"]));
  d.edit("logic:1", "b", 2);
  const second = d.admitKeep(d.select(["logic:1"]));
  d.finishKeepAdmission(first);
  assert.throws(
    () => d.acquireHistoryMutation(revisionOf(d)),
    (e) => (busy(e, "keep-pending"), true),
  );
  d.finishKeepAdmission(second);
  d.finishKeepAdmission(second); // idempotent
  d.releaseHistoryMutation(d.acquireHistoryMutation(revisionOf(d)));
});

test("admitKeep validates the exact issuer selection and refuses during a lease", () => {
  const d = draft();
  const other = draft();
  assert.throws(() => d.admitKeep(other.select(["logic:1"])), /belongs to another workspace/);
  const stale = d.select(["logic:1"]);
  d.edit("logic:1", "a", 1);
  assert.throws(() => d.admitKeep(stale), /Stale selection/);
  const fresh = d.select(["logic:1"]);
  const lease = d.acquireHistoryMutation(revisionOf(d));
  assert.throws(
    () => d.admitKeep(fresh),
    (e) => (busy(e, "native-history"), true),
  );
  d.releaseHistoryMutation(lease);
  const admission = d.admitKeep(fresh);
  assert.throws(() => d.admitKeep({ ...fresh }), /belongs to another workspace/);
  d.finishKeepAdmission(admission);
  assert.throws(() => d.acknowledgeAdmittedKeep(admission), /already settled/);
});

test("the admitted acknowledgement applies only its reserved selection", () => {
  const d = draft();
  d.edit("logic:1", "a", 1);
  const admission = d.admitKeep(d.select(["logic:1"]));
  // Newer typing does not invalidate the admitted selection's baseline work.
  d.edit("words", "x", 0);
  assert.equal(d.acknowledgeAdmittedKeep(admission), true);
  d.finishKeepAdmission(admission);
  assert.deepEqual(d.dirtyKeys(), ["words"]);
  const forged = Object.freeze({ kind: "keep-admission" }) as DraftKeepAdmission;
  assert.throws(() => d.acknowledgeAdmittedKeep(forged), /belongs to another workspace/);
  assert.throws(() => d.finishKeepAdmission(forged), /belongs to another workspace/);
});
