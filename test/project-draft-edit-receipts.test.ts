import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft, type DraftEditReceipt } from "../src/authoring/projectDraft.ts";

const L1 = "return;";
const WORDS = '[["look",100]]';

/** Type through the same CAS path an editor model's listener uses. */
function type(draft: ProjectDraft, key: string, content: string): DraftEditReceipt | undefined {
  return draft.edit(key, content, draft.capture().version(key));
}

function transact(draft: ProjectDraft, changes: { key: string; content: string }[]) {
  return draft.apply(draft.propose(draft.capture(), "guided", changes));
}

test("receipted edits reverse through issued authority so the transaction's undo still verifies", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const tx = transact(draft, [
    { key: "logic:1", content: L1 + "\n// placed" },
    { key: "words", content: '[["look",100],["wave",104]]' },
  ]);
  const first = type(draft, "logic:1", L1 + "\n// placed\n// typed 1");
  const second = type(draft, "logic:1", L1 + "\n// placed\n// typed 1\n// typed 2");
  assert.ok(first && second, "each authored write issues a receipt");
  // Native-style reversal restores the exact pre-typing origin, not just bytes.
  draft.reverseEdits([first, second]);
  assert.equal(draft.capture().read("logic:1")!.content, L1 + "\n// placed");
  draft.undo(tx.id);
  assert.equal(draft.capture().read("logic:1")!.content, L1);
  assert.equal(draft.capture().read("words")!.content, WORDS);
  // Redo restores the transaction, then the typed group reapplies to the same
  // lineage position it was issued at.
  draft.redo(tx.id);
  assert.equal(draft.capture().read("words")!.content, '[["look",100],["wave",104]]');
  draft.reapplyEdits([first, second]);
  assert.equal(
    draft.capture().read("logic:1")!.content,
    L1 + "\n// placed\n// typed 1\n// typed 2",
  );
  assert.throws(() => draft.reverseEdits([first]), /conflict|applied/i);
});

test("a net-zero native group restores the origin even though bytes are unchanged", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const tx = transact(draft, [
    { key: "logic:1", content: L1 + "\n// placed" },
    { key: "words", content: '[["look",100],["wave",104]]' },
  ]);
  const revisionBefore = draft.capture().revision;
  const insert = type(draft, "logic:1", L1 + "\n// placed\nx");
  const remove = type(draft, "logic:1", L1 + "\n// placed");
  assert.ok(insert && remove);
  // The group nets to zero bytes; the reversal must still move the origin back.
  draft.reverseEdits([insert, remove]);
  assert.equal(draft.capture().read("logic:1")!.content, L1 + "\n// placed");
  assert.ok(
    draft.capture().revision > revisionBefore + 2,
    "an origin-only restoration advances the revision",
  );
  draft.undo(tx.id);
  assert.equal(draft.capture().read("logic:1")!.content, L1);
  assert.equal(draft.capture().read("words")!.content, WORDS);
});

test("a no-op edit issues no receipt and advances nothing", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const before = draft.capture();
  const receipt = type(draft, "logic:1", L1);
  assert.equal(receipt, undefined);
  assert.equal(draft.capture().revision, before.revision);
  assert.equal(draft.capture().version("logic:1"), before.version("logic:1"));
});

test("foreign, forged, duplicate, unordered and missing-middle groups refuse atomically", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const other = new ProjectDraft({ "logic:1": L1 });
  const first = type(draft, "logic:1", L1 + "\n// a")!;
  const second = type(draft, "logic:1", L1 + "\n// a\n// b")!;
  const third = type(draft, "logic:1", L1 + "\n// a\n// b\n// c")!;
  const foreign = type(other, "logic:1", L1 + "\n// x")!;
  assert.throws(() => draft.reverseEdits([]), /receipt/i);
  assert.throws(() => draft.reverseEdits([foreign]), /workspace|foreign|receipt/i);
  assert.throws(
    () => draft.reverseEdits([Object.freeze({ key: "logic:1" })]),
    /workspace|foreign|receipt/i,
  );
  assert.throws(() => draft.reverseEdits([first, first]), /duplicate/i);
  assert.throws(() => draft.reverseEdits([second, first]), /order|contiguous/i);
  assert.throws(() => draft.reverseEdits([first, third]), /order|contiguous/i);
  assert.throws(() => draft.reverseEdits([first, second, second]), /duplicate|order|contiguous/i);
  // Mixed direction: reversing a group containing an already-reversed receipt
  // refuses without touching revision, content or any receipt state.
  draft.reverseEdits([third]);
  const before = draft.capture();
  assert.throws(() => draft.reverseEdits([first, second, third]), /applied|state/i);
  const now = draft.capture();
  assert.equal(now.revision, before.revision, "a refused group cannot write");
  assert.equal(now.read("logic:1")!.content, L1 + "\n// a\n// b");
});

test("an intervening ordinary write breaks the group and the refusal leaves everything", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const first = type(draft, "logic:1", L1 + "\n// a")!;
  // An unreceipted-in-group ordinary write lands between the receipts; even
  // though later edits return the buffer to identical bytes, the lineage moved.
  type(draft, "logic:1", L1 + "\n// a\n// mid");
  type(draft, "logic:1", L1 + "\n// a");
  const second = type(draft, "logic:1", L1 + "\n// a\n// b")!;
  assert.throws(() => draft.reverseEdits([first, second]), /order|contiguous|conflict/i);
  assert.equal(draft.capture().read("logic:1")!.content, L1 + "\n// a\n// b");
});

test("a transaction on the document blocks the group until the transaction moves", () => {
  const draft = new ProjectDraft({ "logic:1": L1, words: WORDS });
  const first = type(draft, "logic:1", L1 + "\n// a")!;
  const second = type(draft, "logic:1", L1 + "\n// a\n// b")!;
  const tx = transact(draft, [
    { key: "logic:1", content: L1 + "\n// a\n// b\n// placed" },
    { key: "words", content: '[["look",100],["wave",104]]' },
  ]);
  const before = draft.capture();
  // The group's own after-origin is no longer current: refuse, change nothing.
  assert.throws(() => draft.reverseEdits([first, second]), /conflict|later edits/i);
  assert.equal(draft.capture().revision, before.revision);
  assert.equal(draft.capture().read("logic:1")!.content, L1 + "\n// a\n// b\n// placed");
  // Restore the prerequisite legitimately (the transaction moves first), then
  // the same refused group is usable again.
  draft.undo(tx.id);
  draft.reverseEdits([first, second]);
  assert.equal(draft.capture().read("logic:1")!.content, L1);
});

test("a reversed group reapplies only in order and refuses over newer work", () => {
  const draft = new ProjectDraft({ "logic:1": L1 });
  const first = type(draft, "logic:1", L1 + "\n// a")!;
  const second = type(draft, "logic:1", L1 + "\n// a\n// b")!;
  draft.reverseEdits([first, second]);
  assert.throws(() => draft.reverseEdits([first, second]), /applied|state/i);
  // Reapplying only the newer half leaves the lineage unanchored: the oldest
  // expected origin is not current, so the origin CAS refuses.
  assert.throws(() => draft.reapplyEdits([second]), /order|contiguous|state|later edits/i);
  assert.throws(() => draft.reapplyEdits([second, first]), /order|contiguous|state|later edits/i);
  draft.reapplyEdits([first, second]);
  assert.equal(draft.capture().read("logic:1")!.content, L1 + "\n// a\n// b");
  // And a reapplication is itself a fully fresh origin position for further work.
  draft.reverseEdits([first, second]);
  type(draft, "logic:1", L1 + "\n// different");
  assert.throws(() => draft.reapplyEdits([first, second]), /conflict|later edits/i);
});

test("byte receipts own their images; reversing restores the exact bytes", () => {
  const draft = new ProjectDraft({ "view:1": Uint8Array.of(1, 2), "logic:1": L1 });
  const bytes = Uint8Array.of(9, 9, 9);
  const receipt = draft.edit("view:1", bytes, draft.capture().version("view:1"))!;
  bytes[0] = 0;
  draft.reverseEdits([receipt]);
  assert.deepEqual(draft.capture().read("view:1")!.content, Uint8Array.of(1, 2));
  draft.reapplyEdits([receipt]);
  assert.deepEqual(draft.capture().read("view:1")!.content, Uint8Array.of(9, 9, 9));
});
