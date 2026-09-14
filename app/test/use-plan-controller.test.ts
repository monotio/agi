import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";
import { usePlanController } from "../src/usePlanController.ts";
import { useRoomMap } from "../src/useRoomMap.ts";
import type { AgentSession } from "../src/agent/agentSession.ts";
import { readPendingPlan, readPlanDraft } from "../src/planStore.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import type { EngineState, TextHook } from "../src/useEngineTypes.ts";
import type { AuthoringController } from "../src/useAuthoringController.ts";
import type { LogAgentFn } from "../src/useInputController.ts";

const STUB: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
const BOOT = { projectId: "custom-plan001", templateId: "custom", title: "The Plan" };

function memStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => void values.set(k, v),
    removeItem: (k) => void values.delete(k),
  } as Storage;
}

/**
 * The controller wired the way useEngine wires it: a real room map in review
 * mode editing the controller's draft, a real stub-backed session, and the
 * boot tail captured instead of spawning a worker.
 */
function makeHarness(backingStorage?: Storage) {
  const state = reactive({
    phase: "idle",
    paused: false,
    powerUp: { open: false },
    roomJournal: [],
    walkthrough: { active: false, status: "idle", tick: 0 },
    patchTick: 0,
    planReview: null,
    error: "",
    agentLog: [],
  }) as unknown as EngineState;
  const hook = reactive({ room: -1 }) as unknown as TextHook;
  const storage = backingStorage ?? memStorage();
  const logAgent: LogAgentFn = () => {};
  let session: AgentSession | null = null;
  const authoring = {
    getSession: () => session,
    setSession: (s: AgentSession | null) => {
      session = s;
    },
    resetSession: () => {
      session?.task.cancel();
      session = null;
    },
    attachSessionRuntime: () => {},
  } as unknown as AuthoringController;
  const builds: { resources: unknown; boot: unknown }[] = [];
  const roomBuilds: { room: number; from: number; notes: string[] }[] = [];
  let config = STUB;

  const map = useRoomMap({
    state,
    hook,
    getBootedGame: () => null,
    getSession: () => authoring.getSession(),
    pauseEngine: () => {},
    resumeEngine: () => {},
    pauseWalkthrough: () => {},
    resumeWalkthrough: () => {},
    storage,
    getReviewDraft: () => state.planReview?.draft ?? null,
    onReviewEdited: () => plan.persistDraft(),
    onReviewClosed: () => plan.keepReview(),
  });

  const plan = usePlanController({
    state,
    logAgent,
    roomMap: map,
    authoring,
    getLlmConfig: () => config,
    setActiveLlmConfig: (c) => {
      config = c;
    },
    finishAuthoredBoot: async (_session, resources, boot) => {
      builds.push({ resources, boot });
    },
    buildRoomFromMap: async (room, from, notes) => {
      roomBuilds.push({ room, from, notes });
    },
    storage,
  });

  return { state, map, plan, authoring, builds, roomBuilds, storage };
}

test("start runs the plan turn and opens the map as the review surface", async () => {
  const { state, map, plan, storage } = makeHarness();
  await plan.start("# Brief\nA test.", STUB, BOOT);
  assert.equal(state.phase, "idle");
  assert.equal(map.reviewing.value, true);
  const review = state.planReview;
  assert.ok(review);
  assert.equal(review.title, "The Plan");
  // The stub's three-room world is the draft the map edits.
  assert.deepEqual(Object.keys(review.draft.world.rooms).sort(), ["1", "2", "3"]);
  assert.equal(review.draft.world.rooms["1"]?.title, "The Clearing");
  // Nothing was built: no resources, no boot.
  assert.equal(readPendingPlan(storage), "custom-plan001");
  assert.ok(readPlanDraft(storage, "custom-plan001"));
});

test("a map edit lands on the draft and persists", async () => {
  const { state, map, plan, storage } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  assert.equal(map.renamePlannedRoom(1, "The Meadow"), null);
  assert.equal(state.planReview?.draft.world.rooms["1"]?.title, "The Meadow");
  await nextTick();
  const stored = readPlanDraft(storage, "custom-plan001");
  assert.equal(stored?.world.rooms["1"]?.title, "The Meadow");
  // A rejected edit leaves the draft untouched and says why.
  assert.match(map.renamePlannedRoom(99, "Nope") ?? "", /not in the plan/);
  assert.equal(map.planError.value !== "", true);
});

test("keep keeps the stored draft; reopening restores it for another pass", async () => {
  const { state, map, plan } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  map.renamePlannedRoom(1, "The Meadow");
  map.closeMap(); // "Keep the draft"
  assert.equal(map.reviewing.value, false);
  // assert.equal(x, null) would narrow planReview to null for the block.
  assert.equal(state.planReview == null, true);
  assert.ok(plan.pendingPlan.value, "the kept draft stays pending");

  await plan.openPending();
  assert.equal(map.reviewing.value, true);
  const review = state.planReview;
  assert.equal(review?.draft.world.rooms["1"]?.title, "The Meadow");
});

test("revise commits the edited draft, then runs another plan turn", async () => {
  const { state, plan } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  await plan.revise("add a tower annex");
  const rooms = state.planReview?.draft.world.rooms ?? {};
  assert.equal(Object.keys(rooms).length, 4);
  assert.match(rooms["4"]?.title ?? "", /Annex: add a tower annex/);
  assert.equal(rooms["1"]?.exits["annex4"], 4);
});

test("build authors against the approved plan and clears the pending draft", async () => {
  const { state, map, plan, builds, storage } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  await plan.build();
  assert.equal(builds.length, 1);
  const { resources, boot } = builds[0] as {
    resources: { files: Record<string, Uint8Array> };
    boot: { projectId: string };
  };
  assert.equal(boot.projectId, "custom-plan001");
  assert.ok(Object.keys(resources.files).length > 0);
  assert.equal(map.reviewing.value, false);
  assert.equal(state.planReview, null);
  assert.equal(readPendingPlan(storage), null);
});

test("a concurrent world change conflicts instead of overwriting", async () => {
  const { state, plan, authoring } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  const review = state.planReview!;
  // The world moved under the draft — a turn that ran while the map was open.
  authoring.getSession()!.state.authoring.world.facts["concurrent"] = "edit";
  await plan.revise("try anyway");
  assert.equal(review.conflict, true);
  assert.match(review.error, /changed|current/);
  // The world keeps the concurrent fact; the draft's edit did not clobber it.
  assert.equal(authoring.getSession()!.state.authoring.world.facts["concurrent"], "edit");
});

test("buildPlannedRoom authors one room against the planned inbound edge", async () => {
  const { map, plan, roomBuilds } = makeHarness();
  await plan.start("# Brief", STUB, BOOT);
  // Notes pinned on the node and its inbound edge travel as player intent.
  map.setNote(3, "the vault door should feel trapped");
  map.setEdgeNote(2, 3, "north", "the guard watches this way");
  await plan.buildPlannedRoom(3);
  assert.equal(roomBuilds.length, 1);
  assert.equal(roomBuilds[0]?.room, 3);
  assert.equal(roomBuilds[0]?.from, 2); // the plan's north exit targets it
  assert.deepEqual(roomBuilds[0]?.notes, [
    "the vault door should feel trapped",
    'exit from room 2 "north": the guard watches this way',
  ]);
  assert.equal(map.buildingRoom.value, undefined);
  map.endReview();
});

test("a refused draft write keeps the review open until retry or discard", async () => {
  // The quota case: every draft write throws. Keep and Close both route
  // through closeMap — a refused persist must not pretend the plan kept.
  const values = new Map<string, string>();
  let failing = true;
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failing) throw new Error("QuotaExceededError");
      values.set(k, v);
    },
    removeItem: (k: string) => void values.delete(k),
  } as unknown as Storage;
  const { state, map, plan } = makeHarness(storage);
  await plan.start("# Brief", STUB, BOOT);

  const review = state.planReview;
  assert.ok(review);
  assert.equal(review.unsaved, true, "the boot-time persist already failed");
  assert.match(review.error, /could not keep/i);

  // Keep the draft (and Close, and the dialog's Escape → closeMap): the
  // review stays open and editable, the error names the way out.
  map.renamePlannedRoom(1, "Still Mine");
  map.closeMap();
  assert.equal(map.reviewing.value, true, "an unsaved draft never closes as kept");
  assert.equal(state.planReview, review);
  assert.equal(review.draft.world.rooms["1"]?.title, "Still Mine", "the draft stays editable");

  // Storage recovers: the same close retries the write and this time lands.
  failing = false;
  map.closeMap();
  assert.equal(map.reviewing.value, false);
  assert.equal(state.planReview == null, true);
  assert.equal(readPlanDraft(storage, "custom-plan001")?.world.rooms["1"]?.title, "Still Mine");
});

test("explicit discard closes a review whose draft could not persist", async () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  } as unknown as Storage;
  const { state, map, plan } = makeHarness(storage);
  await plan.start("# Brief", STUB, BOOT);
  assert.equal(state.planReview?.unsaved, true);

  map.closeMap(); // refused — the draft is not durable
  assert.equal(map.reviewing.value, true);

  // The player's explicit out: throw the plan away.
  plan.discardPending();
  assert.equal(map.reviewing.value, false);
  assert.equal(state.planReview, null);
});
