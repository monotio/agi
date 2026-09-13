import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthoringState } from "../src/agent/authoringState.ts";
import {
  commitWorldDraft,
  createWorldDraft,
  draftAddExit,
  draftAddRoom,
  draftRemoveExit,
  draftRemoveRoom,
  draftRenameRoom,
  draftSetBrief,
  lowestFreeRoom,
  validateWorldDraft,
  worldRevision,
} from "../src/agent/worldPlan.ts";

function worldWith(
  rooms: Record<string, { title: string; description: string; exits: Record<string, number> }>,
) {
  const state = createAuthoringState();
  state.world.rooms = rooms;
  return state;
}

test("worldRevision is order-insensitive and content-sensitive", () => {
  const a = worldWith({
    "1": { title: "Hall", description: "A quiet hall.", exits: { east: 2, north: 3 } },
    "2": { title: "Vault", description: "Dark.", exits: { west: 1 } },
  });
  const b = worldWith({
    "2": { title: "Vault", description: "Dark.", exits: { west: 1 } },
    "1": { title: "Hall", description: "A quiet hall.", exits: { north: 3, east: 2 } },
  });
  assert.equal(worldRevision(a.world), worldRevision(b.world));
  b.world.rooms["2"]!.description = "Cold.";
  assert.notEqual(worldRevision(a.world), worldRevision(b.world));
  b.world.facts["caretaker"] = "Keeps the brass key.";
  assert.notEqual(worldRevision(a.world), worldRevision(b.world));
});

test("a draft is detached from the world it forked from", () => {
  const state = worldWith({ "1": { title: "Hall", description: "", exits: {} } });
  const draft = createWorldDraft(state.world);
  draft.world.rooms["1"]!.title = "Parlor";
  draft.world.facts["x"] = "y";
  assert.equal(state.world.rooms["1"]!.title, "Hall");
  assert.deepEqual(state.world.facts, {});
});

test("commitWorldDraft commits while the base revision matches", () => {
  const state = worldWith({ "1": { title: "Hall", description: "", exits: {} } });
  const draft = createWorldDraft(state.world);
  draft.world.rooms["1"]!.title = "Parlor";
  draft.world.facts["key"] = "Under the mat.";
  const result = commitWorldDraft(state, draft);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.authoring.world.rooms["1"]!.title, "Parlor");
  assert.equal(result.authoring.world.facts["key"], "Under the mat.");
  // The input state is untouched — the commit returns a new validated state.
  assert.equal(state.world.rooms["1"]!.title, "Hall");
});

test("commitWorldDraft reports a stale base revision as a conflict", () => {
  const state = worldWith({ "1": { title: "Hall", description: "", exits: {} } });
  const draft = createWorldDraft(state.world);
  state.world.rooms["1"]!.title = "Atrium"; // world moved after the fork
  const result = commitWorldDraft(state, draft);
  assert.equal(result.status, "conflict");
});

test("an empty base revision adopts unconditionally (restored draft)", () => {
  const state = createAuthoringState();
  const draft = createWorldDraft(
    worldWith({ "1": { title: "Hall", description: "", exits: {} } }).world,
  );
  draft.baseRevision = "";
  const result = commitWorldDraft(state, draft);
  assert.equal(result.status, "committed");
});

test("commitWorldDraft rejects invalid worlds through the shared validator", () => {
  const state = worldWith({ "1": { title: "Hall", description: "", exits: {} } });
  const draft = createWorldDraft(state.world);
  draft.world.rooms["1"]!.exits["east"] = 999; // same limit update_world enforces
  const result = commitWorldDraft(state, draft);
  assert.equal(result.status, "invalid");
});

test("draft edit ops validate through the shared limits", () => {
  const state = worldWith({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const draft = createWorldDraft(state.world);

  assert.equal(draftRenameRoom(draft, 1, "Parlor"), null);
  assert.equal(draft.world.rooms["1"]!.title, "Parlor");
  assert.match(draftRenameRoom(draft, 9, "Nope") ?? "", /not in the plan/);
  assert.match(draftRenameRoom(draft, 1, "   ") ?? "", /title/);
  assert.match(draftRenameRoom(draft, 1, "x".repeat(200)) ?? "", /title|long|character/i);

  assert.equal(draftSetBrief(draft, 1, "A marble parlor."), null);
  assert.equal(draft.world.rooms["1"]!.description, "A marble parlor.");
  assert.match(draftSetBrief(draft, 9, "x") ?? "", /not in the plan/);

  assert.equal(draftAddRoom(draft, 3, "Cellar", "Below."), null);
  assert.equal(draft.world.rooms["3"]!.title, "Cellar");
  assert.match(draftAddRoom(draft, 3, "Dup", "") ?? "", /already planned/);
  assert.match(draftAddRoom(draft, 999, "Bad", "") ?? "", /room number/);

  assert.equal(draftAddExit(draft, 1, "east", 2), null);
  assert.equal(draft.world.rooms["1"]!.exits["east"], 2);
  assert.match(draftAddExit(draft, 1, "nowhere", 9) ?? "", /not in the plan/);
  assert.match(draftAddExit(draft, 9, "east", 2) ?? "", /not in the plan/);
  assert.match(draftAddExit(draft, 1, "  ", 2) ?? "", /name/);

  assert.equal(draftRemoveExit(draft, 1, "east"), null);
  assert.deepEqual(draft.world.rooms["1"]!.exits, {});
  assert.match(draftRemoveExit(draft, 1, "east") ?? "", /no exit/);
});

test("draftRemoveRoom prunes exits that pointed at the removed room", () => {
  const state = worldWith({
    "1": { title: "Hall", description: "", exits: { east: 2, down: 3 } },
    "2": { title: "Vault", description: "", exits: { west: 1 } },
    "3": { title: "Cellar", description: "", exits: {} },
  });
  const draft = createWorldDraft(state.world);
  assert.equal(draftRemoveRoom(draft, 3), null);
  assert.equal(draft.world.rooms["3"], undefined);
  assert.deepEqual(draft.world.rooms["1"]!.exits, { east: 2 });
  assert.match(draftRemoveRoom(draft, 3) ?? "", /not in the plan/);
});

test("draftRemoveRoom keeps the world valid at the room-count limit", () => {
  const rooms: Record<
    string,
    { title: string; description: string; exits: Record<string, number> }
  > = {};
  for (let i = 1; i <= 255; i++) rooms[String(i)] = { title: `R${i}`, description: "", exits: {} };
  const draft = createWorldDraft(worldWith(rooms).world);
  assert.match(draftAddRoom(draft, 300, "Over", "") ?? "", /room number/);
  assert.equal(lowestFreeRoom(draft.world.rooms), undefined);
  assert.equal(draftRemoveRoom(draft, 255), null);
  assert.equal(lowestFreeRoom(draft.world.rooms), 255);
  assert.equal(
    lowestFreeRoom(draft.world.rooms, (n) => n === 255),
    undefined,
  );
});

test("validateWorldDraft surfaces the same limits as update_world", () => {
  const draft = createWorldDraft(
    worldWith({ "1": { title: "T", description: "", exits: {} } }).world,
  );
  assert.equal(validateWorldDraft(draft), null);
  draft.world.rooms["1"]!.title = "x".repeat(200);
  assert.match(validateWorldDraft(draft) ?? "", /title|long|character/i);
});
