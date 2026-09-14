import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearPendingPlan,
  readPendingPlan,
  readPlanDraft,
  removePlanDraft,
  writePendingPlan,
  writePlanDraft,
  type StoredPlanDraft,
} from "../src/planStore.ts";

/** In-memory Storage stand-in; `writes = false` simulates a quota refusal. */
function memStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  values: Map<string, string>;
  writes: boolean;
} {
  const values = new Map<string, string>();
  return {
    values,
    writes: true,
    getItem: (k) => values.get(k) ?? null,
    setItem(k, v) {
      if (!this.writes) throw new DOMException("quota", "QuotaExceededError");
      values.set(k, v);
    },
    removeItem: (k) => void values.delete(k),
  };
}

function draft(overrides: Partial<StoredPlanDraft> = {}): StoredPlanDraft {
  return {
    version: 1,
    projectId: "demo-abc12345",
    title: "The Test Plan",
    templateId: "custom",
    templateMarkdown: "---\nname: custom\n---\n# The Test Plan\n",
    baseRevision: "abc123",
    world: {
      rooms: {
        "1": { title: "Hall", description: "A quiet hall.", exits: { east: 2 } },
        "2": { title: "Vault", description: "Dark.", exits: { west: 1 } },
      },
      facts: { caretaker: "Keeps the brass key." },
      quests: {},
    },
    savedAt: 1,
    ...overrides,
  };
}

test("a stored plan draft round-trips through storage", () => {
  const storage = memStorage();
  assert.equal(writePlanDraft(storage, draft()), true);
  writePendingPlan(storage, "demo-abc12345");
  assert.equal(readPendingPlan(storage), "demo-abc12345");
  const stored = readPlanDraft(storage, "demo-abc12345");
  assert.equal(stored?.title, "The Test Plan");
  assert.equal(stored?.world.rooms["1"]?.title, "Hall");
  assert.equal(stored?.world.facts["caretaker"], "Keeps the brass key.");
});

test("malformed or oversized drafts fail visibly, never silently", () => {
  const storage = memStorage();
  assert.equal(readPlanDraft(storage, "missing"), null);
  storage.values.set("monotio_agi.plan.bad", "not json");
  assert.throws(() => readPlanDraft(storage, "bad"), /not readable/);
  storage.values.set("monotio_agi.plan.v2", JSON.stringify({ version: 2 }));
  assert.throws(() => readPlanDraft(storage, "v2"), /version/);
  storage.values.set(
    "monotio_agi.plan.broken",
    JSON.stringify({ ...draft(), world: { rooms: "nope" } }),
  );
  assert.throws(() => readPlanDraft(storage, "broken"), /not readable/);
});

test("the pending pointer bounds junk and clears", () => {
  const storage = memStorage();
  storage.values.set("monotio_agi.pendingPlan", "");
  assert.equal(readPendingPlan(storage), null);
  storage.values.set("monotio_agi.pendingPlan", "x".repeat(200));
  assert.equal(readPendingPlan(storage), null);
  writePendingPlan(storage, "demo-abc12345");
  clearPendingPlan(storage);
  assert.equal(readPendingPlan(storage), null);
});

test("a quota refusal returns false and never throws", () => {
  const storage = memStorage();
  storage.writes = false;
  assert.equal(writePlanDraft(storage, draft()), false);
  assert.equal(readPlanDraft(storage, "demo-abc12345"), null);
});

test("a draft over the size cap is refused before the write", () => {
  const storage = memStorage();
  const big = draft({ templateMarkdown: "x".repeat(600 * 1024) });
  assert.equal(writePlanDraft(storage, big), false);
});

test("removePlanDraft drops the record without touching the pointer", () => {
  const storage = memStorage();
  writePlanDraft(storage, draft());
  writePendingPlan(storage, "demo-abc12345");
  removePlanDraft(storage, "demo-abc12345");
  assert.equal(readPlanDraft(storage, "demo-abc12345"), null);
  // The pointer is the caller's concern — readPendingPlan now finds no draft.
  assert.equal(readPendingPlan(storage), "demo-abc12345");
});
