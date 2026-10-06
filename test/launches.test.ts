import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../src/container/container.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "../src/authoring/authoringState.ts";
import {
  addLaunch,
  moveLaunch,
  newLaunchId,
  pruneRoomLaunches,
  readWorldLaunches,
  removeLaunch,
  selectLaunch,
  updateLaunch,
  type Launch,
} from "../src/authoring/launches.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";
import {
  inspectProjectRemoval,
  type ProjectRemovalInput,
} from "../src/authoring/projectRemoval.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profile = PROFILES["2.936"];

function world(launches?: AuthoringState["world"]["launches"]): AuthoringState["world"] {
  return {
    rooms: { "3": { title: "Meadow", description: "", exits: {} } },
    facts: {},
    quests: {},
    ...(launches === undefined ? {} : { launches }),
  };
}

const FULL_LAUNCH: Launch = {
  id: "launch-1",
  name: "Vacuum death",
  note: "Open bay, tune the timing.",
  cameFrom: { room: 8, edge: 3 },
  flags: { "10": true, "2": false },
  variables: { "3": 7 },
  items: { "2": 255, "0": 4 },
  hero: { x: 80, y: 120 },
  seed: 42,
};

test("a full launch validates into a detached, code-point ordered record", () => {
  const raw = {
    "10": { entries: [{ ...FULL_LAUNCH, id: "later" }] },
    "3": {
      selected: "launch-1",
      entries: [
        {
          id: "launch-1",
          name: "  Vacuum death  ",
          note: "Open bay, tune the timing.",
          cameFrom: { room: 8, edge: 3 },
          flags: { "10": true, "2": false },
          variables: { "3": 7 },
          items: { "2": 255, "0": 4 },
          hero: { x: 80, y: 120 },
          seed: 42,
        },
      ],
    },
  };
  const launches = readWorldLaunches(raw);
  assert.deepEqual(Object.keys(launches), ["3", "10"], "room keys in code-point order");
  const launch = launches["3"]!.entries[0]!;
  assert.equal(launch.name, "Vacuum death", "the name is trimmed");
  // Integer-like keys enumerate numerically in any JS object; code-point order
  // is what the canonical serializer emits on top of that.
  assert.deepEqual(Object.keys(launch.flags!), ["2", "10"]);
  assert.deepEqual(Object.keys(launch.items!), ["0", "2"]);
  assert.equal(launch.cameFrom?.edge, 3);
  assert.equal(launch.items!["2"], 255, "255 is 'with the hero'");
  launches["3"]!.entries[0]!.name = "mutated";
  assert.equal((raw["3"].entries[0] as { name: string }).name, "  Vacuum death  ");
});

test("every launch field range refuses with a named reason", () => {
  const cases: [unknown, RegExp][] = [
    [{ "0": { entries: [] } }, /room/i],
    [{ "256": { entries: [] } }, /room/i],
    [{ "03": { entries: [] } }, /room/i],
    [{ "3": { selected: "gone", entries: [] } }, /selected|unknown/i],
    [{ "3": { entries: [{ id: "a", name: "" }] } }, /name/i],
    [{ "3": { entries: [{ id: "a", name: ` ${"x".repeat(61)} ` }] } }, /name/i],
    [{ "3": { entries: [{ id: "a", name: "n", cameFrom: { room: 256 } }] } }, /room/i],
    [{ "3": { entries: [{ id: "a", name: "n", cameFrom: { room: 1, edge: 5 } }] } }, /edge/i],
    [{ "3": { entries: [{ id: "a", name: "n", flags: { "256": true } }] } }, /flag/i],
    [{ "3": { entries: [{ id: "a", name: "n", flags: { "1": 1 } }] } }, /flag|boolean/i],
    [{ "3": { entries: [{ id: "a", name: "n", variables: { "4": 256 } }] } }, /variable/i],
    [{ "3": { entries: [{ id: "a", name: "n", variables: { "4": 1.5 } }] } }, /variable/i],
    [{ "3": { entries: [{ id: "a", name: "n", items: { "300": 1 } }] } }, /item/i],
    [{ "3": { entries: [{ id: "a", name: "n", items: { "2": 256 } }] } }, /item|room/i],
    [{ "3": { entries: [{ id: "a", name: "n", hero: { x: 160, y: 0 } }] } }, /hero|x/i],
    [{ "3": { entries: [{ id: "a", name: "n", hero: { x: 0, y: 168 } }] } }, /hero|y/i],
    [{ "3": { entries: [{ id: "a", name: "n", cameFrom: { room: "8" } }] } }, /room/i],
    [{ "3": { entries: [{ id: "a", name: "n", seed: "42" }] } }, /seed/i],
    [{ "3": { entries: [{ id: "a", name: "n", seed: 65536 }] } }, /seed/i],
    [{ "3": { entries: [{ id: "a", name: "n", seed: -1 }] } }, /seed/i],
    [{ "3": { entries: [{ id: "a", name: "n", future: true }] } }, /field|unknown/i],
    [
      {
        "3": {
          entries: [
            { id: "a", name: "n" },
            { id: "a", name: "again" },
          ],
        },
      },
      /duplicate|id/i,
    ],
    [{ "3": { entries: [{ id: "carry", name: "n" }] } }, /reserved|carry|beginning/i],
    [{ "3": { selected: "carry", entries: [] } }, null!],
    [{ "3": { selected: "beginning", entries: [] } }, null!],
    [{ "3": { entries: [] } }, null!],
  ];
  for (const [value, pattern] of cases) {
    if (pattern === null) {
      readWorldLaunches(value);
    } else {
      assert.throws(() => readWorldLaunches(value), pattern, JSON.stringify(value));
    }
  }
});

test("the authoring state carries world launches and rejects invalid ones", () => {
  const state = createAuthoringState();
  state.world.launches = {
    "3": { entries: [FULL_LAUNCH] },
  };
  const restored = validateAuthoringState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.world.launches, state.world.launches);
  restored.world.launches!["3"]!.entries[0]!.name = "mutated";
  assert.equal(state.world.launches["3"]!.entries[0]!.name, "Vacuum death");
  assert.equal(
    Object.hasOwn(validateAuthoringState(createAuthoringState()).world, "launches"),
    false,
    "absent launches stay absent",
  );
  assert.throws(
    () =>
      validateAuthoringState({
        ...state,
        world: {
          ...state.world,
          launches: { "3": { entries: [{ id: "x", name: "n", hero: { x: -1, y: 0 } }] } },
        },
      }),
    /launch/i,
  );
});

test("edit helpers add, update, move, select and remove launches", () => {
  let next = addLaunch(world(), 3, {
    name: "Vacuum death",
    cameFrom: { room: 8, edge: 3 },
    seed: 42,
  });
  const first = next.launches!["3"]!.entries[0]!;
  assert.equal(first.id, "launch-1");
  next = addLaunch(next, 3, { id: "from-door", name: "Through the door" });
  assert.equal(next.launches!["3"]!.entries[1]!.id, "from-door");
  assert.equal(newLaunchId(next.launches!["3"]), "launch-2");

  next = updateLaunch(next, 3, "launch-1", { hero: { x: 12, y: 20 } });
  assert.deepEqual(next.launches!["3"]!.entries[0]!.hero, { x: 12, y: 20 });
  assert.equal(next.launches!["3"]!.entries[0]!.seed, 42, "unpatched fields hold");
  assert.throws(() => updateLaunch(next, 3, "missing", { name: "x" }), /launch 'missing'/i);
  assert.throws(() => updateLaunch(next, 3, "launch-1", { name: " " }), /name/i);

  next = selectLaunch(next, 3, "from-door");
  assert.equal(next.launches!["3"]!.selected, "from-door");
  next = selectLaunch(next, 3, "carry");
  assert.equal(Object.hasOwn(next.launches!["3"]!, "selected"), false);
  assert.throws(() => selectLaunch(next, 3, "missing"), /launch|selected/i);

  next = moveLaunch(next, 3, "from-door", 0);
  assert.deepEqual(
    next.launches!["3"]!.entries.map((entry) => entry.id),
    ["from-door", "launch-1"],
  );
  assert.throws(() => moveLaunch(next, 3, "from-door", 5), /index|position/i);

  next = selectLaunch(next, 3, "launch-1");
  next = removeLaunch(next, 3, "launch-1");
  assert.deepEqual(
    next.launches!["3"]!.entries.map((entry) => entry.id),
    ["from-door"],
  );
  assert.equal(
    Object.hasOwn(next.launches!["3"]!, "selected"),
    false,
    "removing the selected launch restores the default",
  );
  next = removeLaunch(next, 3, "from-door");
  assert.equal(Object.hasOwn(next, "launches"), false, "an emptied room drops its launches entry");
  assert.throws(() => removeLaunch(next, 3, "from-door"), /room 3|launches/i);

  // Helpers never mutate their input and their output revalidates.
  const before = world();
  const after = addLaunch(before, 9, { name: "Side room" });
  assert.equal(before.launches, undefined);
  validateAuthoringState({ version: 1, bindings: {}, world: after });
});

test("removal review flags launches tied to a removed room", () => {
  const container = openContainer(new Map(), { profile });
  for (const num of [0, 1, 3]) {
    container.putResource(
      "logic",
      num,
      compileProjectLogic("return;", { profile, dictionary: new Map(), bindings: {} }).assembly
        .payload,
    );
  }
  const image = inspectProjectReferences({ container, profile });
  const authoring = (launches: AuthoringState["world"]["launches"]) =>
    validateAuthoringState({ version: 1, bindings: {}, world: world(launches) });
  const review = (authored: AuthoringState): ReturnType<typeof inspectProjectRemoval> =>
    inspectProjectRemoval({
      removals: ["logic:8"],
      image,
      authoring: authored,
      tests: undefined,
      references: undefined,
      drafts: [],
      keptBindings: {},
      profile,
    } satisfies Partial<ProjectRemovalInput> as ProjectRemovalInput);

  // Room 8's own launches refuse to survive its removal.
  const held = review(authoring({ "8": { entries: [{ id: "a", name: "Bay entry" }] } }));
  assert.ok(
    held.some((finding) => /launch/i.test(finding.message) && /logic:8/.test(finding.message)),
    JSON.stringify(held),
  );
  // Another room's launch that came from room 8 refuses too.
  const inbound = review(
    authoring({
      "3": { entries: [{ id: "a", name: "From the bay", cameFrom: { room: 8 } }] },
    }),
  );
  assert.ok(
    inbound.some((finding) => /logic:8/.test(finding.message)),
    JSON.stringify(inbound),
  );
  // Unrelated launches pass.
  const clean = review(
    authoring({ "3": { entries: [{ id: "a", name: "From the bay", cameFrom: { room: 1 } }] } }),
  );
  assert.deepEqual(
    clean.filter((finding) => /launch/i.test(finding.message)),
    [],
  );
});

test("pruneRoomLaunches deletes the room's launches and strips cameFrom and item references", () => {
  const initialWorld = world({
    "8": {
      entries: [{ id: "bay", name: "Bay entry", seed: 123 }],
    },
    "3": {
      entries: [
        {
          id: "meadow-entry",
          name: "Meadow from bay",
          cameFrom: { room: 8, edge: 2 },
          items: { "1": 255, "2": 8 },
        },
      ],
    },
  });

  const pruned = pruneRoomLaunches(initialWorld, 8);
  assert.equal(pruned.launches?.["8"], undefined, "room 8 launches are deleted");
  assert.ok(pruned.launches?.["3"]);
  const meadowLaunch = pruned.launches["3"]!.entries[0]!;
  assert.equal(meadowLaunch.cameFrom, undefined, "cameFrom pointing to room 8 is stripped");
  assert.deepEqual(meadowLaunch.items, { "1": 255 }, "item placed in room 8 is stripped");

  const container = openContainer(new Map(), { profile });
  for (const num of [0, 1, 3]) {
    container.putResource(
      "logic",
      num,
      compileProjectLogic("return;", { profile, dictionary: new Map(), bindings: {} }).assembly
        .payload,
    );
  }
  const image = inspectProjectReferences({ container, profile });
  const review = inspectProjectRemoval({
    removals: ["logic:8"],
    image,
    authoring: validateAuthoringState({ version: 1, bindings: {}, world: pruned }),
    tests: undefined,
    references: undefined,
    drafts: [],
    keptBindings: {},
    profile,
  } satisfies Partial<ProjectRemovalInput> as ProjectRemovalInput);

  assert.deepEqual(
    review.filter((finding) => /launch/i.test(finding.message)),
    [],
    "after pruning, projectRemoval reports no launch blockers",
  );
});
