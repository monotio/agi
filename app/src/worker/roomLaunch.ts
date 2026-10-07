import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import { roomEntryProblem, type RoomEntryState } from "../../../src/runtime/roomEntry.ts";
import { stageDictionary } from "../../../src/runtime/previewAdmission.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { detachedHost } from "./runSession.ts";
import type { HostRngState } from "../../../src/runtime/rng.ts";
import { installProjectRestart } from "./projectRestart.ts";
import type { Inbound, WorkerContext } from "./context.ts";
import type { PreviewPreparedSession } from "./debuggerState.ts";

export interface RoomLaunchRequest {
  room: number;
  state?: RoomEntryState;
  beginning?: boolean;
  debug?: boolean;
  fromMyGame?: boolean;
}
export interface PreparedRoomLaunch {
  engine: Engine;
  activate(): void;
  rng: HostRngState;
  beginning: boolean;
  debug: boolean;
  debugSession?: PreviewPreparedSession;
}

/** Prepare a detached entry before changing any live state or host presentation. */
export function prepareRoomLaunch(
  ctx: WorkerContext,
  request: RoomLaunchRequest,
  files = ctx.run.engine!.containerFiles,
  profile: AgiProfile = ctx.run.engine!.profile,
  authority?: Pick<PreviewPreparedSession, "sources" | "sourceBindings" | "bindings">,
): PreparedRoomLaunch {
  if (!ctx.run.owner.active) throw new Error("Take back to play this game");
  const prior = ctx.run.engine!;
  if (!Number.isInteger(request.room) || request.room < 0 || request.room > 255)
    throw new Error("Choose a room between 0 and 255");
  for (const option of [request.beginning, request.debug])
    if (option !== undefined && typeof option !== "boolean")
      throw new Error("Launch options must be true or false");
  if (!request.beginning && profile.id !== prior.profile.id)
    throw new Error("Choose From the beginning to change the interpreter profile");
  if (request.debug && !ctx.run.debugger.epoch)
    throw new Error("Open Debug before starting this launch");
  const state = request.state === undefined ? {} : request.state;
  const facade = detachedHost(ctx);
  const replacement = new Engine(
    openContainer(files, { profile }),
    facade.host,
    files.get("WORDS.TOK") ? stageDictionary(files.get("WORDS.TOK")!) : new Map(),
    { profile },
  );
  if (request.beginning) replacement.flags[9] = 1;
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
    activate: facade.activate,
    beginning: request.beginning === true,
    // Explicit seeds override fresh-start entropy (docs/fidelity.md, "Host RNG policy").
    rng:
      state.seed !== undefined
        ? {
            word: state.seed,
            policy: {
              kind: "sequence",
              next: state.seed,
              cursor: 0,
              ...(ctx.run.progress.mode === "play" ? { untilRoomChange: true as const } : {}),
            },
          }
        : request.beginning
          ? { word: 0, policy: { kind: "external" } }
          : structuredClone(ctx.run.rng),
    debug: request.debug === true,
    ...(ctx.run.debugger.epoch
      ? { debugSession: ctx.fns.prepareDebugReplacement(replacement, authority) }
      : {}),
  };
}

/** Run a validated entry after its engine and source authority have moved together. */
export function runRoomLaunch(ctx: WorkerContext, prepared: PreparedRoomLaunch): void {
  const { engine: replacement } = prepared;
  if (!prepared.beginning) ctx.fns.markJump();
  ctx.fns.historyResume();
  ctx.fns.tickEngine();
  if (!replacement.executionControlActive) ctx.fns.finishCycle();
  ctx.fns.noteTransition();
  ctx.fns.captureStateDiffs();
  ctx.fns.postFrame(true);
}

export function launchRoom(ctx: WorkerContext, msg: Inbound<"playHere">): string | null {
  let prepared: PreparedRoomLaunch;
  try {
    prepared = prepareRoomLaunch(ctx, { room: msg.room, ...msg.launch });
  } catch (cause) {
    return `${cause instanceof Error ? cause.message : String(cause)}.`;
  }
  ctx.fns.autosave(true);
  installProjectRestart(ctx, prepared.engine, prepared.beginning ? "beginning" : "launch", {
    rng: prepared.rng,
    paused: ctx.run.cycle.paused,
    activate: prepared.activate,
    debug: prepared.debug,
    ...(prepared.debugSession ? { debugSession: prepared.debugSession } : {}),
  });
  runRoomLaunch(ctx, prepared);
  return null;
}
