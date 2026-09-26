import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  begin,
  cancel,
  commit,
  createHistory,
  record,
  redo,
  undo,
  type EditHistory,
  type HistoryResult,
} from "../src/studio/editHistory.ts";

function ok(result: HistoryResult): EditHistory {
  if (!result.ok) assert.fail(result.reason);
  return result.history;
}

function refused(result: HistoryResult, pattern: RegExp): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, pattern);
}

/** Record a chain of edits a -> b -> c ... from the history's current text. */
function chain(history: EditHistory, ...sources: string[]): EditHistory {
  for (const source of sources)
    history = ok(record(history, `to ${source}`, history.current, source));
  return history;
}

describe("edit history", () => {
  it("undoes and redoes recorded snapshots and clears redo on a new edit", () => {
    const history = chain(createHistory("a"), "b", "c");
    assert.deepEqual(
      history.past.map((step) => [step.label, step.source]),
      [
        ["to b", "a"],
        ["to c", "b"],
      ],
    );
    const undone = undo(history, "c");
    assert.ok(undone.ok);
    assert.equal(undone.source, "b");
    const back = undo(undone.history, "b");
    assert.ok(back.ok && back.source === "a" && back.history.past.length === 0);
    refused(undo(back.history, "a"), /nothing to undo/);
    const redone = redo(back.history, "a");
    assert.ok(redone.ok && redone.source === "b");
    assert.deepEqual(redone.history.future, [{ label: "to c", source: "c" }]);
    const branched = ok(record(redone.history, "to x", "b", "x"));
    assert.deepEqual(branched.future, []);
    refused(redo(branched, "x"), /nothing to redo/);
  });

  it("coalesces a gesture into one step", () => {
    let history = begin(createHistory("a"), "drag");
    history = chain(history, "a1", "a2", "a3");
    assert.equal(history.past.length, 0);
    refused(undo(history, "a3"), /in progress/);
    history = commit(history);
    assert.deepEqual(history.past, [{ label: "drag", source: "a" }]);
    const undone = undo(history, "a3");
    assert.ok(undone.ok && undone.source === "a");
    // A gesture that ends where it began leaves no step; begin commits an open one.
    assert.deepEqual(commit(chain(begin(createHistory("a"), "noop"), "a1", "a")).past, []);
    const twice = begin(chain(begin(createHistory("a"), "first"), "b"), "second");
    assert.deepEqual(twice.past, [{ label: "first", source: "a" }]);
    assert.deepEqual(twice.gesture, { label: "second", source: "b" });
  });

  it("cancels a gesture back to where it began", () => {
    const dragging = chain(begin(createHistory("a"), "drag"), "a1", "a2");
    const cancelled = cancel(dragging, "a2");
    assert.ok(cancelled.ok && cancelled.source === "a");
    assert.deepEqual(cancelled.history.past, []);
    assert.equal(cancelled.history.gesture, undefined);
    refused(cancel(cancelled.history, "a"), /no edit is in progress/);
  });

  it("refuses to overwrite a change made outside the history", () => {
    const history = chain(createHistory("a"), "b");
    refused(undo(history, "b-edited-elsewhere"), /changed outside the edit history/);
    refused(record(history, "to c", "b-edited-elsewhere", "c"), /changed outside/);
    const undone = ok(undo(history, "b"));
    refused(redo(undone, "a-edited-elsewhere"), /changed outside/);
  });

  it("keeps at most `depth` steps, dropping the oldest", () => {
    const history = chain(createHistory("s0", 3), "s1", "s2", "s3", "s4", "s5");
    assert.deepEqual(
      history.past.map((step) => step.source),
      ["s2", "s3", "s4"],
    );
    assert.equal(createHistory("x").depth, 200);
    assert.throws(() => createHistory("x", 0), /depth/);
  });
});
