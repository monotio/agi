import { Engine, type EngineHost } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import { roomEntryProblem, type RoomEntryState } from "../../../src/runtime/roomEntry.ts";
import { stageDictionary } from "../../../src/runtime/previewAdmission.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { installProjectRestart } from "./projectRestart.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export interface RoomLaunchRequest {
  room: number;
  state?: RoomEntryState;
  beginning?: boolean;
  debug?: boolean;
}
export interface PreparedRoomLaunch {
  engine: Engine;
  activate(): void;
  seed: number | undefined;
  debug: boolean;
}

/** Prepare a detached entry before changing any live state or host presentation. */
export function prepareRoomLaunch(
  ctx: WorkerContext,
  request: RoomLaunchRequest,
  files = ctx.engine!.containerFiles,
  profile: AgiProfile = ctx.engine!.profile,
): PreparedRoomLaunch {
  const prior = ctx.engine!;
  if (!Number.isInteger(request.room) || request.room < 0 || request.room > 255)
    throw new Error("Choose a room between 0 and 255");
  for (const option of [request.beginning, request.debug])
    if (option !== undefined && typeof option !== "boolean")
      throw new Error("Launch options must be true or false");
  if (!request.beginning && profile.id !== prior.profile.id)
    throw new Error("Choose From the beginning to change the interpreter profile");
  if (request.debug && !ctx.debugger.epoch)
    throw new Error("Open Debug before starting this launch");
  const state = request.state === undefined ? {} : request.state;
  let active = false;
  // Restore/transition calls are private until admission; the installed host
  // then forwards every callback through the same worker context.
  const host: EngineHost = new Proxy(ctx.host!, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (active || key === "soundDevice") return Reflect.apply(value, target, args);
        if (key === "takeKeys" || key === "takePointerClicks") return [];
        if (key === "prepareRoom") return true;
        return null;
      };
    },
  });
  const replacement = new Engine(
    openContainer(files, { profile }),
    host,
    files.get("WORDS.TOK") ? stageDictionary(files.get("WORDS.TOK")!) : new Map(),
    { profile },
  );
  const inventory = replacement.readState().inventory;
  const priorItems = prior.readState().inventory.length;
  const problem = roomEntryProblem(state, inventory.length);
  if (problem) throw new Error(problem);
  if (!request.beginning && !openContainer(files, { profile }).getResource("logic", request.room))
    throw new Error(`Room ${request.room} needs a LOGIC to enter`);
  try {
    replacement.amigaRegion = prior.amigaRegion;
    if (!request.beginning) {
      const oldGlobal = openContainer(prior.containerFiles, { profile: prior.profile }).getResource(
        "logic",
        0,
      );
      const global = openContainer(files, { profile }).getResource("logic", 0);
      const sameGlobal =
        oldGlobal?.length === global?.length &&
        oldGlobal?.every((byte, index) => byte === global?.[index]);
      const { image, replay } = prior.captureRoomLaunchState(!sameGlobal);
      replacement.restoreImage(image, { preservePresentation: true });
      replacement.restoreReplayState(replay);
      replacement.abortInteraction();
      for (const item of inventory.slice(priorItems))
        replacement.setItemLocation(item.num, item.room);
      replacement.reenterRoom(request.room, state);
    }
  } catch (cause) {
    throw new Error(
      `Launch could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return {
    engine: replacement,
    activate() {
      active = true;
    },
    seed: state.seed,
    debug: request.debug === true,
  };
}

/** Run a validated entry after its engine and source authority have moved together. */
export function runRoomLaunch(ctx: WorkerContext, prepared: PreparedRoomLaunch): void {
  const { engine: replacement } = prepared;
  // Only a Create run is temporary; a Launch while playing keeps saving progress.
  ctx.previewVisitEngine = ctx.boot.progressMode === "create" ? replacement : null;
  if (prepared.seed !== undefined) ctx.history.rng = prepared.seed;
  ctx.history.launchReseed = prepared.seed;
  ctx.history.launchEngine = replacement;
  prepared.activate();
  ctx.fns.markJump();
  ctx.fns.debugSessionReplaced(prepared.debug);
  ctx.fns.historyResume();
  ctx.fns.tickEngine();
  if (!replacement.executionControlActive) ctx.fns.finishCycle();
  ctx.fns.noteTransition();
  ctx.fns.captureStateDiffs();
  ctx.fns.postFrame(true);
  ctx.fns.startTimers();
}

export function launchRoom(ctx: WorkerContext, msg: Inbound<"playHere">): string | null {
  let prepared: PreparedRoomLaunch;
  try {
    prepared = prepareRoomLaunch(ctx, { room: msg.room, ...msg.launch });
  } catch (cause) {
    return `${cause instanceof Error ? cause.message : String(cause)}.`;
  }
  const prior = ctx.engine!;
  const paused = ctx.cycle.paused;
  const rng = ctx.history.rng;
  if (ctx.previewVisitEngine !== prior) ctx.fns.autosave(true);
  installProjectRestart(ctx, prepared.engine);
  ctx.cycle.paused = paused;
  ctx.history.rng = rng;
  runRoomLaunch(ctx, prepared);
  return null;
}
