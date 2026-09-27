/**
 * Room Studio's Walk view: where the player can stand (an estimate), test
 * walks the real game runs, and the room's doors.
 *
 * - The tint is `walkableMask` for ego's size on the planes on screen: an
 *   estimate, labelled so. Only an engine run says where ego gets.
 * - A test walk takes a start (a click, or a door: where the player enters
 *   through it) and a goal, shows `planRoute`'s estimate while the goal is
 *   chosen, then runs `testRoute` on a throwaway copy of the game with the
 *   draft picture and logic in it, off the main thread. The result names
 *   what stopped it: the item under the refused cell.
 * - Doors are the room's exits (walkView.ts): annotated rules are edited
 *   through the logic draft, one kernel rule edit per change; everything
 *   else is read-only. A door box that follows a picture item shows moved
 *   with it before the Keep moves it for real.
 */

import { computed, shallowRef, watch } from "vue";
import { openContainer } from "../../../src/container/container.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";
import { planRoute, type RoutePlan, type RouteTestResult } from "../../../src/studio/route.ts";
import { RULE_EDIT_BLOCKERS } from "../../../src/studio/rules/logicDocument.ts";
import type { FlagRef, RuleBox, RuleModel } from "../../../src/studio/rules/ruleModel.ts";
import { roomExitContracts, type ExitContract } from "../../../src/studio/rules/ruleUsage.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { walkableMask, type WalkableInput } from "../../../src/studio/walkable.ts";
import type { StudioRoomSource } from "../world/studioSource.ts";
import { runRouteInWorker, type RouteRunner } from "./routeRunner.ts";
import { rectFrom } from "./studioTools.ts";
import type { StudioNotice } from "./useStudioNotice.ts";
import { toShown, toStored, type RoomLogicDraft } from "./useRoomLogicDraft.ts";
import {
  destinationLabel,
  EDGE_NAMES,
  edgeAt,
  entrySpot,
  freshRuleId,
  outcomeTitle,
  refusedCell,
  walkDoors,
  type EdgeSide,
  type WalkDoor,
} from "./walkView.ts";

/** The walking actor's shape and rules for the estimate: ego as the live game holds it. */
export interface EgoShape {
  readonly width: number;
  readonly height: number;
  readonly observeBlocks: boolean;
  readonly waterGate: WalkableInput["waterGate"];
  /** The horizon ego stays below; null under ignore.horizon. */
  readonly horizon: number | null;
  readonly bypassControl: boolean;
}

/** Until the live game answers: a small actor under the default horizon. */
export const DEFAULT_EGO: EgoShape = {
  width: 3,
  height: 6,
  observeBlocks: true,
  waterGate: null,
  horizon: 36,
  bypassControl: false,
};

/** A finished test walk as the result card shows it. */
export interface WalkResult {
  readonly from: Point;
  readonly to: Point;
  readonly result: RouteTestResult;
  /** The card's headline: "Reached", "Blocked at Rope barrier", … */
  readonly title: string;
  /** "live": run with the live game's flags and variables; "fresh": from a new boot. */
  readonly state: "live" | "fresh";
}

/** The live game's flags and variables (256 each), as the worker's state query reports them. */
export interface LiveGameState {
  readonly flags: readonly number[];
  readonly vars: readonly number[];
}

/**
 * The game's own state a test walk carries over: flags from f16 and
 * variables from v27. The lower ones are the interpreter's (room numbers,
 * edges, input, timers); room entry sets them itself.
 */
export const FIRST_GAME_FLAG = 16;
export const FIRST_GAME_VAR = 27;

/** testRoute's preset for a live state: every game flag and variable as it stands. */
export function livePreset(state: LiveGameState): {
  flags: { id: number; value: boolean }[];
  vars: { id: number; value: number }[];
} {
  const flags: { id: number; value: boolean }[] = [];
  const vars: { id: number; value: number }[] = [];
  for (let id = FIRST_GAME_FLAG; id < 256; id++)
    flags.push({ id, value: (state.flags[id] ?? 0) !== 0 });
  for (let id = FIRST_GAME_VAR; id < 256; id++)
    vars.push({ id, value: (state.vars[id] ?? 0) & 0xff });
  return { flags, vars };
}

export interface StudioWalkOptions {
  readonly walk: () => StudioRoomSource | null | undefined;
  /** The booted game's files the Studio opened on. */
  readonly files: () => ReadonlyMap<string, Uint8Array> | undefined;
  readonly profile: () => AgiProfile;
  readonly pictureNumber: () => number;
  /** The picture as last kept and as on screen (a drag's preview included). */
  readonly keptPicture: () => PictureDocument;
  readonly shownPicture: () => PictureDocument;
  /** The draft picture's compiled bytes: what a test walk runs on. */
  readonly pictureBytes: () => Uint8Array;
  /** The priority plane on screen. */
  readonly priority: () => Uint8Array;
  readonly logic: RoomLogicDraft;
  /** The picture item owning a cell on the priority plane, by label. */
  readonly labelAt: (x: number, y: number) => string | undefined;
  readonly itemLabel: (id: string) => string;
  readonly ego: () => EgoShape;
  readonly say: (notice: StudioNotice | null) => void;
  /** Door edits are blocked: view only, or a Keep that needs a reload. */
  readonly frozen: () => boolean;
  /** Door edits wait for an AI proposal's verdict (or its request). */
  readonly paused?: () => boolean;
  readonly runner?: RouteRunner | undefined;
  /** Reads the live game's flags and variables; absent or null when there is no live game. */
  readonly liveState?: (() => Promise<LiveGameState | null>) | undefined;
}

export function useStudioWalk(options: StudioWalkOptions) {
  const { logic } = options;
  const runner = options.runner ?? runRouteInWorker;
  const room = computed(() => options.walk()?.room ?? 0);
  const rooms = computed(() => options.walk()?.rooms ?? []);

  // ---- The walkable estimate --------------------------------------------

  const walkInput = computed<WalkableInput>(() => {
    const ego = options.ego();
    return {
      priority: options.priority(),
      egoWidth: ego.width,
      egoHeight: ego.height,
      observeBlocks: ego.observeBlocks,
      waterGate: ego.waterGate,
      horizon: ego.horizon,
      bypassControl: ego.bypassControl,
    };
  });
  const mask = computed(() => walkableMask(walkInput.value));
  const horizon = computed(() => options.ego().horizon ?? 0);

  // ---- Doors ---------------------------------------------------------------

  /** Every logic of the game, with this room's draft logic in place. */
  const logics = computed(() => {
    const out = new Map<number, Uint8Array>();
    const files = options.files();
    if (!files) return out;
    try {
      const container = openContainer(new Map(files));
      for (let n = 0; n < 256; n++) {
        const payload = container.getResource("logic", n);
        if (payload) out.set(n, payload);
      }
    } catch {
      return out;
    }
    const draft = logic.bytes.value;
    if (draft && room.value > 0) out.set(room.value, draft);
    return out;
  });
  const contracts = computed<ExitContract[]>(() => {
    const walk = options.walk();
    if (!walk || room.value < 1) return [];
    return roomExitContracts({
      room: room.value,
      logics: logics.value,
      profile: options.profile(),
      plan: walk.authoring.world.rooms,
      tests: walk.tests,
      rules: logic.rules.value,
    });
  });
  /** Doors as stored in the logic. */
  const storedDoors = computed(() => walkDoors(logic.rules.value, contracts.value));
  /** A door box being dragged: its box on screen. */
  const moving = shallowRef<{ id: string; box: RuleBox } | null>(null);
  /** Doors as shown: a box following an item moves with it. */
  const doors = computed<WalkDoor[]>(() =>
    storedDoors.value.map((door) => {
      if (moving.value?.id === door.id) return { ...door, box: moving.value.box };
      if (!door.box) return door;
      return {
        ...door,
        box: toShown(door.box, door.item, options.keptPicture(), options.shownPicture()),
      };
    }),
  );
  const selectedDoorId = shallowRef<string | null>(null);
  const selectedDoor = computed(
    () => doors.value.find((door) => door.id === selectedDoorId.value) ?? null,
  );
  watch(doors, (list) => {
    if (selectedDoorId.value && !list.some((door) => door.id === selectedDoorId.value))
      selectedDoorId.value = null;
  });
  /** Rooms a test walk reached through a room change this session: their doors count as tested. */
  const walkedTo = shallowRef<ReadonlySet<number>>(new Set());
  /** A broken rule annotation (duplicated, nested or unterminated): the kernel refuses every edit. */
  const logicBlocked = computed(
    () => logic.diagnostics.value.find((entry) => RULE_EDIT_BLOCKERS.includes(entry.code)) ?? null,
  );
  const canEditDoors = computed(
    () =>
      logic.editable.value &&
      !options.frozen() &&
      !options.paused?.() &&
      logicBlocked.value === null,
  );
  /** The kernel's reason a typed flag name was refused, shown under the flag field. */
  const flagError = shallowRef<string | null>(null);
  watch(selectedDoorId, () => (flagError.value = null));
  const labelOf = (door: Pick<WalkDoor, "destination">): string =>
    destinationLabel(door.destination, rooms.value);

  /** A room a new door leads to: the first other room of the map, else the next number. */
  function defaultDestination(): number {
    return rooms.value.find((choice) => choice.room !== room.value)?.room ?? room.value + 1;
  }

  function refuse(text: string, detail?: string): false {
    options.say({ tone: "warn", text, detail });
    return false;
  }

  /** One rule edit on the room's logic: one undo step, refused whole with the kernel's words. */
  function edit(
    op: Parameters<RoomLogicDraft["apply"]>[0],
    label: string,
    done: string,
    onRefusal?: (error: string) => void,
  ): boolean {
    if (options.frozen()) return refuse("This room is view only: its doors can't be changed.");
    if (options.paused?.()) return refuse("Accept or reject the AI's proposal first.");
    if (!logic.editable.value)
      return refuse("This room's logic is native: change its exits as text, or ask the assistant.");
    const outcome = logic.apply(op, label);
    if (!outcome.ok) {
      onRefusal?.(outcome.error);
      return refuse("The door can't be changed that way.", outcome.error);
    }
    options.say({ tone: "ok", text: done });
    return true;
  }

  const ruleIds = (): string[] => logic.rules.value.map((entry) => entry.rule.id);

  /** Add a door box over `box` (screen cells) leading to the default room. */
  function addDoor(box: RuleBox): boolean {
    const id = freshRuleId(ruleIds(), "door");
    const destination = defaultDestination();
    const added = edit(
      {
        op: "addRule",
        id,
        label: `Door to room ${destination}`,
        model: { kind: "exit", edge: null, box, destination, requiresFlag: null },
      },
      "Add door",
      `Added a door box ${destinationLabel(destination, rooms.value)}.`,
    );
    if (added) selectedDoorId.value = id;
    return added;
  }

  /** Add an exit through `edge`, unless one already leaves there. */
  function addEdge(edge: EdgeSide): boolean {
    const existing = doors.value.find((door) => door.edge === edge && door.shape === "edge");
    if (existing) {
      selectedDoorId.value = existing.id;
      return refuse(
        existing.editable
          ? `The ${EDGE_NAMES[edge]} edge already has an exit: change it here.`
          : `The ${EDGE_NAMES[edge]} edge already leads to room ${existing.destination} in the room's own logic.`,
      );
    }
    const id = freshRuleId(ruleIds(), `exit-${EDGE_NAMES[edge]}`);
    const destination = defaultDestination();
    const added = edit(
      {
        op: "addRule",
        id,
        label: `${EDGE_NAMES[edge][0]!.toUpperCase()}${EDGE_NAMES[edge].slice(1)} edge`,
        model: { kind: "exit", edge, destination, requiresFlag: null, blockedMessage: null },
      },
      "Add edge exit",
      `Added an exit by the ${EDGE_NAMES[edge]} edge ${destinationLabel(destination, rooms.value)}.`,
    );
    if (added) selectedDoorId.value = id;
    return added;
  }

  /** The editable door's model with `patch` applied; null for a native door. */
  function modelOf(
    door: WalkDoor,
    patch: Partial<{ destination: number; requiresFlag: FlagRef | null; box: RuleBox }>,
  ): RuleModel | null {
    const entry = logic.rules.value.find((candidate) => candidate.rule.id === door.id);
    const model = entry?.model;
    if (!model || model === "native" || model.kind !== "exit") return null;
    if (model.edge === null)
      return {
        ...model,
        destination: patch.destination ?? model.destination,
        requiresFlag: patch.requiresFlag === undefined ? model.requiresFlag : patch.requiresFlag,
        box: patch.box ?? model.box,
      };
    const requiresFlag = patch.requiresFlag === undefined ? model.requiresFlag : patch.requiresFlag;
    return {
      ...model,
      destination: patch.destination ?? model.destination,
      requiresFlag,
      // A blocked message needs the flag that blocks.
      blockedMessage: requiresFlag === null ? null : model.blockedMessage,
    };
  }

  function update(
    id: string,
    patch: Partial<{ destination: number; requiresFlag: FlagRef | null; box: RuleBox }>,
    item: string | null | undefined,
    label: string,
    done: string,
    onRefusal?: (error: string) => void,
  ): boolean {
    const door = storedDoors.value.find((candidate) => candidate.id === id);
    const model = door && modelOf(door, patch);
    if (!door || !model)
      return refuse("Only a door this room's rules describe can be changed here.");
    return edit(
      { op: "updateRule", id, model, ...(item === undefined ? {} : { item }) },
      label,
      done,
      onRefusal,
    );
  }

  function setDestination(id: string, destination: number): boolean {
    return update(
      id,
      { destination },
      undefined,
      "Change where a door leads",
      `The door now leads ${destinationLabel(destination, rooms.value)}.`,
    );
  }

  function setFlag(id: string, flag: FlagRef | null): boolean {
    flagError.value = null;
    return update(
      id,
      { requiresFlag: flag },
      undefined,
      "Change a door's condition",
      flag === null ? "The door is always open." : `The door opens only while ${flag} is set.`,
      (error) => (flagError.value = error),
    );
  }

  /** Place a door box on screen (a drag or the box fields): stored in the kept picture's frame. */
  function moveDoor(id: string, box: RuleBox): boolean {
    const door = storedDoors.value.find((candidate) => candidate.id === id);
    if (!door) return false;
    const stored = toStored(box, door.item, options.keptPicture(), options.shownPicture());
    return update(id, { box: stored }, undefined, "Move a door box", "Moved the door box.");
  }

  /**
   * Make the door box follow picture item `item` (null: stop following).
   * It stays where it shows: the box is re-stored in the kept frame of its
   * new item.
   */
  function setFollows(id: string, item: string | null): boolean {
    const door = doors.value.find((candidate) => candidate.id === id);
    if (!door?.box) return refuse("Only a door box can follow the art.");
    const box = toStored(door.box, item, options.keptPicture(), options.shownPicture());
    return update(
      id,
      { box },
      item,
      "Change what a door follows",
      item === null
        ? "The door box no longer follows the art."
        : `The door box now follows ${options.itemLabel(item)}: moving it moves the door.`,
    );
  }

  function removeDoor(id: string): boolean {
    return edit({ op: "removeRule", id }, "Remove a door", "Removed the door.");
  }

  // ---- Door gestures on the canvas ----------------------------------------

  /** The door box being drawn with the door tool. */
  const drawing = shallowRef<{ start: Point; end: Point } | null>(null);
  const drawnBox = computed(() => {
    const d = drawing.value;
    return d ? rectFrom(d.start, d.end, false) : null;
  });
  let grab: { id: string; from: Point; box: RuleBox } | null = null;

  /** Start dragging a door box from `cell`. */
  function grabDoor(id: string, cell: Point): void {
    const door = doors.value.find((candidate) => candidate.id === id);
    selectedDoorId.value = id;
    if (!door?.box || !door.editable || !canEditDoors.value) return;
    grab = { id, from: cell, box: door.box };
  }
  function dragDoor(cell: Point): void {
    if (!grab) return;
    const dx = Math.max(-grab.box.x1, Math.min(159 - grab.box.x2, cell.x - grab.from.x));
    const dy = Math.max(-grab.box.y1, Math.min(167 - grab.box.y2, cell.y - grab.from.y));
    const { x1, y1, x2, y2 } = grab.box;
    moving.value = { id: grab.id, box: { x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy } };
  }
  function dropDoor(): void {
    const drop = moving.value;
    grab = null;
    moving.value = null;
    if (drop) moveDoor(drop.id, drop.box);
  }

  // ---- Test walks ----------------------------------------------------------

  const start = shallowRef<Point | null>(null);
  const goal = shallowRef<Point | null>(null);
  /** The cell under the pointer while a goal is being chosen: the estimate follows it. */
  const aim = shallowRef<Point | null>(null);
  const running = shallowRef(false);
  const result = shallowRef<WalkResult | null>(null);
  /** Why the last walk could not run at all. */
  const failure = shallowRef<string | null>(null);
  /** Test walks start from the live game's flags and variables when it has them. */
  const useLiveState = shallowRef(true);
  let run = 0;

  /** The estimate from the start to the goal (or the cell being aimed at). */
  const estimate = computed<RoutePlan | null>(() => {
    const from = start.value;
    const to = goal.value ?? aim.value;
    if (!from || !to) return null;
    try {
      return planRoute({
        ...walkInput.value,
        from,
        to,
        profile: options.profile(),
      });
    } catch {
      return null;
    }
  });

  /** What a test walk step asks for next, in words. */
  const prompt = computed(() => {
    if (running.value) return "Walking…";
    if (!start.value)
      return "Click where the walk starts, or a door to start where the player enters.";
    if (!goal.value) return "Click the goal.";
    return "Click to start another walk.";
  });

  function clearWalk(): void {
    run++;
    start.value = null;
    goal.value = null;
    aim.value = null;
    result.value = null;
    failure.value = null;
    running.value = false;
  }

  function setStart(at: Point, how?: string): void {
    run++;
    running.value = false;
    start.value = at;
    goal.value = null;
    result.value = null;
    failure.value = null;
    options.say({
      tone: "ok",
      text: `${how ?? "The walk starts"} at ${at.x},${at.y}. Now click the goal.`,
    });
  }

  /** A click with the test walk tool: the start, then the goal (which runs the walk). */
  function clickWalk(at: Point): void {
    if (!start.value || goal.value) return setStart(at);
    goal.value = at;
    void runWalk();
  }

  /** Walk from the start to `at` now (the canvas menu's "Test walk to here"). */
  function walkTo(at: Point): void {
    if (!start.value) return void setStart(at);
    goal.value = at;
    void runWalk();
  }

  /** Start where the player enters this room through `door`. */
  function startFromDoor(id: string): void {
    const door = doors.value.find((candidate) => candidate.id === id);
    if (!door) return;
    const back = roomExitContracts({
      room: door.destination,
      logics: logics.value,
      profile: options.profile(),
    }).find((contract) => contract.destination === room.value);
    const spot = entrySpot(door, back ?? null, mask.value, horizon.value);
    if (!spot) {
      refuse(`No spot to start from near ${labelOf(door)}: click a start instead.`);
      return;
    }
    setStart(spot, `The walk starts where the player comes in from room ${door.destination}`);
  }

  /** The game's files with the draft picture and logic in them: what a walk runs on. */
  function draftFiles(): Record<string, Uint8Array> | null {
    const files = options.files();
    if (!files) return null;
    const container = openContainer(new Map(files));
    container.putResource("picture", options.pictureNumber(), options.pictureBytes());
    if (logic.editable.value && room.value > 0) {
      const followed = logic.forKeep(options.keptPicture(), options.shownPicture());
      const bytes = followed.ok && "bytes" in followed ? followed.bytes : logic.bytes.value;
      if (bytes) container.putResource("logic", room.value, bytes);
    }
    return Object.fromEntries(container.files);
  }

  async function runWalk(): Promise<void> {
    const from = start.value;
    const to = goal.value;
    const files = draftFiles();
    if (!from || !to) return;
    if (!files || room.value < 1) {
      failure.value = "This picture is not framed by a room the game can enter.";
      return;
    }
    const mine = ++run;
    running.value = true;
    result.value = null;
    failure.value = null;
    const path = estimate.value?.path;
    try {
      let live: LiveGameState | null = null;
      if (useLiveState.value && options.liveState)
        live = await options.liveState().catch(() => null);
      if (mine !== run) return;
      const walked = await runner({
        ...(live ? livePreset(live) : {}),
        files,
        profile: options.profile().id,
        room: room.value,
        from,
        to,
        ...(path && path.length > 2 ? { via: path.slice(1, -1) } : {}),
      });
      if (mine !== run) return;
      let blockedBy: string | null = null;
      if (walked.outcome === "blocked") {
        const cell = refusedCell(walkInput.value, walked.end, to);
        blockedBy = cell ? (options.labelAt(cell.x, cell.y) ?? null) : null;
      }
      // A walk that left through a door tests that door's way out.
      if (walked.outcome === "room_changed" && walked.room !== room.value)
        walkedTo.value = new Set([...walkedTo.value, walked.room]);
      result.value = {
        from,
        to,
        result: walked,
        title: outcomeTitle(walked, blockedBy, rooms.value),
        state: live ? "live" : "fresh",
      };
    } catch (error) {
      if (mine !== run) return;
      failure.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (mine === run) running.value = false;
    }
  }

  /** Walk the same start and goal again (after an edit). */
  function again(): void {
    if (start.value && goal.value) void runWalk();
  }

  // ---- Tool gestures (useStudioTools' walk tools) --------------------------

  /** A press with a walk tool at `cell`; true when it took it. */
  function press(tool: "walk" | "door" | "edge", cell: Point): boolean {
    if (tool === "walk") {
      clickWalk(cell);
      return true;
    }
    if (!canEditDoors.value) {
      refuse(
        !logic.editable.value
          ? "This room's logic is native: its exits change as text, or through the assistant."
          : logicBlocked.value !== null
            ? "Fix the room's rule annotations as text first; door editing is off until then."
            : "This room is view only: its doors can't be changed.",
      );
      return true;
    }
    if (tool === "edge") {
      addEdge(edgeAt(cell, horizon.value));
      return true;
    }
    drawing.value = { start: cell, end: cell };
    return true;
  }
  function dragTo(cell: Point): void {
    if (drawing.value) drawing.value = { ...drawing.value, end: cell };
    else dragDoor(cell);
  }
  function release(): void {
    const box = drawnBox.value;
    drawing.value = null;
    if (box) {
      if (box.x2 - box.x1 < 1 || box.y2 - box.y1 < 1)
        refuse("Drag out a door box: it needs some width and height.");
      else addDoor(box);
      return;
    }
    dropDoor();
  }
  function cancel(): boolean {
    const was = drawing.value !== null || moving.value !== null || grab !== null;
    drawing.value = null;
    moving.value = null;
    grab = null;
    return was;
  }
  const busy = (): boolean => drawing.value !== null || grab !== null;

  return {
    room,
    rooms,
    walkInput,
    mask,
    horizon,
    contracts,
    doors,
    selectedDoorId,
    selectedDoor,
    selectDoor: (id: string | null) => void (selectedDoorId.value = id),
    walked: walkedTo,
    canEditDoors,
    /** The logic source's annotation problems; broken rules stop door editing. */
    logicDiagnostics: logic.diagnostics,
    flagError,
    labelOf,
    addDoor,
    addEdge,
    setDestination,
    setFlag,
    moveDoor,
    setFollows,
    removeDoor,
    drawnBox,
    moving,
    grabDoor,
    dragDoor,
    dropDoor,
    start,
    goal,
    aim,
    estimate,
    running,
    useLiveState,
    setUseLiveState: (on: boolean) => void (useLiveState.value = on),
    result,
    failure,
    prompt,
    clearWalk,
    setStart,
    clickWalk,
    walkTo,
    startFromDoor,
    runWalk,
    again,
    draftFiles,
    press,
    dragTo,
    release,
    cancel,
    busy,
  };
}

export type StudioWalk = ReturnType<typeof useStudioWalk>;
