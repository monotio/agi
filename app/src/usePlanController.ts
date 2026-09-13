/**
 * The plan-review controller: the orchestration between a create request, the
 * agent's plan turn and the world map's review surface.
 *
 * Flows it owns:
 * - start: run the plan turn, detach the world into a review draft, open the
 *   map over the library as the review surface, persist the draft.
 * - revise: commit the player's edited draft back to the session world, run a
 *   revise turn answering their note, detach the result for another pass.
 * - build: commit the draft (revision-checked), run the build turn against the
 *   approved plan, then finish the authored boot. Closing the review never
 *   builds; a kept draft persists and the library offers to resume it.
 * - buildPlannedRoom: the live map's "extend the game" — author one planned
 *   room's resources through the same room turn the engine's just-in-time
 *   path uses, then patch the running world.
 *
 * The draft in state.planReview is the map's edit target; every map edit
 * lands through onReviewEdited, which persists it. baseRevision "" marks an
 * adopted draft — one restored from storage whose in-memory session world is
 * the empty fresh one.
 */
import { ref } from "vue";
import { AgentSession, type BootResources } from "./agent/agentSession.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import {
  createWorldDraft,
  worldRevision,
  type WorldDraft,
  type WorldPlan,
} from "../../src/agent/worldPlan.ts";
import type { AuthoringController } from "./useAuthoringController.ts";
import type { RoomMap } from "./useRoomMap.ts";
import type { EngineState } from "./useEngineTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";
import type { ProjectId } from "./gameTypes.ts";
import {
  clearPendingPlan,
  readPendingPlan,
  readPlanDraft,
  removePlanDraft,
  writePendingPlan,
  writePlanDraft,
  type StoredPlanDraft,
} from "./planStore.ts";

/** The review state while the map is the plan surface; null otherwise. */
export interface PlanReviewUiState {
  projectId: string;
  title: string;
  templateId?: string;
  /** The create request the plan answers — the build turn needs it verbatim. */
  templateMarkdown: string;
  /** The detached draft the map edits; persists on every accepted edit. */
  draft: WorldDraft;
  /** A plan, revise or build turn is in flight. */
  busy: boolean;
  /** The last turn's failure, shown in the review bar. */
  error: string;
  /**
   * The world moved since the draft forked (a concurrent agent turn). Build
   * and revise refuse until the player refreshes the draft from the world.
   */
  conflict: boolean;
}

export interface PlanBoot {
  projectId: ProjectId;
  templateId?: string | undefined;
  title: string;
}

export interface PlanControllerDeps {
  readonly state: EngineState;
  readonly logAgent: LogAgentFn;
  readonly roomMap: RoomMap;
  readonly authoring: Pick<
    AuthoringController,
    "getSession" | "setSession" | "resetSession" | "attachSessionRuntime"
  >;
  readonly getLlmConfig: () => LlmConfig;
  readonly setActiveLlmConfig: (config: LlmConfig) => void;
  readonly finishAuthoredBoot: (
    session: AgentSession,
    resources: BootResources,
    boot: PlanBoot & { config: LlmConfig },
  ) => Promise<void>;
  /** Author one planned room's resources into the running game. */
  readonly buildRoomFromMap: (room: number, from: number, notes: string[]) => Promise<void>;
  /** Injectable for tests; defaults to browser storage. */
  readonly storage?: Storage | undefined;
}

export function usePlanController(deps: PlanControllerDeps) {
  const { state, logAgent, roomMap, authoring } = deps;
  const storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);

  /** The pending draft's stored header — the library's resume offer. */
  const pendingPlan = ref<StoredPlanDraft | null>(readPending());

  function readPending(): StoredPlanDraft | null {
    if (!storage) return null;
    const projectId = readPendingPlan(storage);
    if (!projectId) return null;
    try {
      return readPlanDraft(storage, projectId);
    } catch {
      return null;
    }
  }

  /** Persist the live draft and point the pending marker at its project. */
  function persistDraft(): void {
    const review = state.planReview;
    if (!review || !storage) return;
    const stored: StoredPlanDraft = {
      version: 1,
      projectId: review.projectId,
      title: review.title,
      ...(review.templateId !== undefined ? { templateId: review.templateId } : {}),
      templateMarkdown: review.templateMarkdown,
      baseRevision: review.draft.baseRevision,
      world: review.draft.world,
    };
    if (writePlanDraft(storage, stored)) {
      writePendingPlan(storage, review.projectId);
      pendingPlan.value = stored;
    } else {
      review.error = "Browser storage could not keep this plan draft. It stays open, unsaved.";
    }
  }

  /** Forget a stored draft; the current review is untouched unless asked. */
  function clearStoredPlan(projectId: string): void {
    if (!storage) return;
    removePlanDraft(storage, projectId);
    clearPendingPlan(storage);
    pendingPlan.value = null;
  }

  /**
   * Plan turn for a create request: the agent designs the world, the result
   * becomes a detached review draft and the map opens over the library. No
   * resource is authored and nothing is booted — build is a separate,
   * player-approved step.
   */
  async function start(templateMarkdown: string, config: LlmConfig, boot: PlanBoot): Promise<void> {
    if (state.planReview?.busy) return;
    if (state.phase !== "idle" && state.phase !== "error") return;
    deps.setActiveLlmConfig(config);
    state.phase = "loading";
    state.error = "";
    try {
      const session = new AgentSession(config, logAgent);
      authoring.setSession(session);
      await session.runPlan(templateMarkdown);
      state.planReview = {
        projectId: boot.projectId,
        title: boot.title,
        ...(boot.templateId !== undefined ? { templateId: boot.templateId } : {}),
        templateMarkdown,
        draft: createWorldDraft(session.state.authoring.world),
        busy: false,
        error: "",
        conflict: false,
      };
      persistDraft();
      // The library stays underneath; the map reviews the draft over it.
      state.phase = "idle";
      roomMap.beginReview(boot.projectId);
    } catch (error) {
      state.planReview = null;
      authoring.resetSession();
      state.phase = "error";
      state.error = String(error);
    }
  }

  /** Reopen a kept draft: a fresh session adopts the stored world. */
  async function openPending(): Promise<void> {
    const stored = readPending();
    if (!stored || state.planReview?.busy) return;
    if (state.phase !== "idle" && state.phase !== "error") return;
    const config = deps.getLlmConfig();
    deps.setActiveLlmConfig(config);
    try {
      const session = new AgentSession(config, logAgent);
      session.adoptWorldPlan(stored.world);
      authoring.setSession(session);
      state.planReview = {
        projectId: stored.projectId,
        title: stored.title,
        ...(stored.templateId !== undefined ? { templateId: stored.templateId } : {}),
        templateMarkdown: stored.templateMarkdown,
        // "" adopts unconditionally — the fresh session's world is this draft.
        draft: { baseRevision: "", world: structuredClone(stored.world) },
        busy: false,
        error: "",
        conflict: false,
      };
      roomMap.beginReview(stored.projectId);
    } catch (error) {
      state.planReview = null;
      authoring.resetSession();
      logAgent("error", `The stored plan could not be reopened: ${String(error)}`);
      clearStoredPlan(stored.projectId);
    }
  }

  /** Throw the stored draft away; the create panel stops offering it. */
  function discardPending(): void {
    const stored = pendingPlan.value;
    if (stored) clearStoredPlan(stored.projectId);
    else if (storage) {
      clearPendingPlan(storage);
      pendingPlan.value = null;
    }
    if (state.planReview && !state.planReview.busy) {
      roomMap.endReview();
      state.planReview = null;
      authoring.resetSession();
    }
  }

  /**
   * The map's own Close during a review: keep the stored draft, drop the
   * session — reopening adopts the stored world into a fresh one.
   */
  function keepReview(): void {
    persistDraft();
    state.planReview = null;
    authoring.resetSession();
  }

  /**
   * A boot or eject replaced the screen: drop the review state without
   * another persist — the stored draft already holds every accepted edit.
   * The approved-plan build clears planReview before it spawns the worker,
   * so this never cancels the session a boot is attaching.
   */
  function teardownReview(): void {
    if (!state.planReview && !roomMap.reviewing.value) return;
    roomMap.endReview();
    state.planReview = null;
    authoring.resetSession();
  }

  /**
   * Commit the draft back to the session world. Returns false on a conflict —
   * the caller surfaces it and waits for a refresh instead of overwriting a
   * concurrent turn's work.
   */
  function commitDraft(review: PlanReviewUiState): boolean {
    const session = authoring.getSession();
    if (!session) {
      review.error = "The authoring session is gone — reopen the plan.";
      return false;
    }
    const result = session.commitPlanDraft(review.draft);
    if (result.status === "conflict") {
      review.conflict = true;
      review.error = "The plan changed elsewhere — refresh to see the current version.";
      return false;
    }
    if (result.status === "invalid") {
      review.error = result.error;
      return false;
    }
    review.conflict = false;
    // The committed world is the new fork point: rebase the draft so a later
    // edit doesn't conflict against the revision it just replaced.
    review.draft.baseRevision = worldRevision(result.authoring.world);
    return true;
  }

  /**
   * Conflict recovery: fork a fresh draft from the world as it now stands —
   * the player's unsaved draft edits are replaced, which is exactly what the
   * conflict warning offered.
   */
  function refreshDraft(): void {
    const review = state.planReview;
    const session = authoring.getSession();
    if (!review || !session) return;
    review.draft = createWorldDraft(session.state.authoring.world);
    review.conflict = false;
    review.error = "";
    persistDraft();
  }

  /**
   * Another plan turn answering the player's note. The edited draft commits
   * first, so inspect_world_bible shows the player's version of the world —
   * their edits are inputs to the revision, not suggestions the turn may
   * silently revert.
   */
  async function revise(note: string): Promise<void> {
    const review = state.planReview;
    const session = authoring.getSession();
    if (!review || !session || review.busy || !note.trim()) return;
    review.busy = true;
    review.error = "";
    try {
      if (!commitDraft(review)) return;
      await session.runRevisePlan(note.trim());
      review.draft = createWorldDraft(session.state.authoring.world);
      persistDraft();
    } catch (error) {
      review.error = String(error);
    } finally {
      review.busy = false;
    }
  }

  /**
   * Build the approved plan: commit the draft against the session world, run
   * the build turn against it, then boot the authored game. Only this path
   * turns a draft into resources — closing or keeping a draft never builds.
   */
  async function build(): Promise<void> {
    const review = state.planReview;
    const session = authoring.getSession();
    if (!review || !session || review.busy) return;
    review.busy = true;
    review.error = "";
    try {
      if (!commitDraft(review)) return;
      const resources = await session.runBuild(review.templateMarkdown);
      roomMap.endReview();
      state.planReview = null;
      await deps.finishAuthoredBoot(session, resources, {
        projectId: review.projectId,
        templateId: review.templateId,
        title: review.title,
        config: deps.getLlmConfig(),
      });
      // The draft is spent only once the game is actually booting — a boot
      // failure leaves the stored plan resumable.
      clearStoredPlan(review.projectId);
    } catch (error) {
      if (state.planReview === review) review.error = String(error);
      else {
        // The draft was already handed to the boot path — the failure
        // belongs to the screen, not a review the player can't see.
        state.phase = "error";
        state.error = String(error);
      }
    } finally {
      if (state.planReview) state.planReview.busy = false;
    }
  }

  /**
   * Extend the running game from a map node: author one planned room's
   * resources through the same room turn just-in-time authoring uses, against
   * the planned inbound edge when the plan names one. The map stays open —
   * the patch lands on the paused live game.
   */
  async function buildPlannedRoom(room: number): Promise<void> {
    if (roomMap.buildingRoom.value !== undefined) return;
    const entry = roomMap.plannedEntry(room);
    if (!entry) {
      roomMap.planError.value = `Room ${room} is not in the plan.`;
      return;
    }
    let from: number | null = null;
    const rooms = (authoring.getSession()?.state.authoring.world.rooms ?? {}) as WorldPlan["rooms"];
    for (const [num, candidate] of Object.entries(rooms)) {
      if (Object.values(candidate.exits).includes(room)) {
        from = Number(num);
        break;
      }
    }
    from ??= roomMap.currentRoom.value ?? 1;
    roomMap.setBuilding(room);
    roomMap.planError.value = "";
    try {
      await deps.buildRoomFromMap(room, from, roomMap.noteIntentFor(room));
    } catch (error) {
      roomMap.planError.value = String(error);
    } finally {
      roomMap.setBuilding(undefined);
    }
  }

  return {
    pendingPlan,
    start,
    openPending,
    discardPending,
    keepReview,
    teardownReview,
    refreshDraft,
    revise,
    build,
    buildPlannedRoom,
    persistDraft,
  };
}

export type PlanController = ReturnType<typeof usePlanController>;
