import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import { decodeHostImage, decodeSave } from "../../../src/runtime/persistence.ts";
import { fnv1a32 } from "../../../src/runtime/hash.ts";
import {
  HISTORY_FINGERPRINT_VERSION,
  historyBootSemantic,
  historyFingerprint,
  stampBoot,
  type HistoryBoot,
} from "../../../src/agent/history.ts";
import { base64ToBytes, bytesToBase64 } from "../project/bytes.ts";
import { stageDictionary } from "../../../src/runtime/previewAdmission.ts";
import { prepareRoomLaunch, runRoomLaunch } from "./roomLaunch.ts";
import { detachedHost, replaceRun, type PreparedRun } from "./runSession.ts";
import { newRunSession } from "./runState.ts";
import { configureSessionTiming } from "./session.ts";
import { createHistory } from "./history.ts";
import type { WorkerContext } from "./context.ts";

/** A Create boot owns its return point before any callback can execute the candidate. */
export function prepareCreateProgress(
  ctx: WorkerContext,
  prepared: PreparedRun,
): WorkerContext["run"]["progress"] {
  const stage: WorkerContext = {
    ...ctx,
    boot: {
      ...ctx.boot,
      ...prepared.settings,
      project: prepared.project,
      liveDictionary: prepared.dictionary ?? new Map(),
      authoredWords: null,
    },
    run: {
      ...newRunSession(ctx.ports.now()),
      engine: prepared.engine,
      rng: structuredClone(prepared.rng),
    },
    fns: { ...ctx.fns, debugCaptureBlocked: () => false },
  };
  configureSessionTiming(stage);
  const returnPoint = createHistory(stage).historySnapshot(true);
  if (!returnPoint) throw new Error("Your game needs a fresh start. Choose Restart.");
  return { mode: "create", returnPoint, cycle: 0, tick: 0, room: prepared.engine.vars[0]! };
}

export function enterCreateRun(ctx: WorkerContext, cold = false): void {
  if (ctx.run.progress.mode === "create") return;
  const engine = ctx.run.engine;
  if (
    !engine ||
    ctx.run.hostRequests.hostRequestOutstanding ||
    (engine.hostInteractionPending && !engine.awaitingKey)
  )
    throw new Error("Finish the game's question, then open Create.");
  const returnPoint = ctx.fns.historySnapshot(
    cold || (!ctx.run.cycle.initialLogicStarted && ctx.run.cycle.cycleCount === 0),
  );
  if (!returnPoint) throw new Error("Continue the game, then open Create.");
  if (!cold) ctx.fns.autosave(true);
  ctx.run.progress = {
    mode: "create",
    returnPoint: stampBoot({
      ...returnPoint,
      clock: {
        ...(returnPoint.clock ?? ctx.run.clocks.cycle.snapshot()),
        paused: ctx.run.cycle.paused,
      },
    }),
    cycle: ctx.run.cycle.cycleCount,
    tick: ctx.run.cycle.tickCount,
    room: engine.vars[0]!,
  };
  ctx.run.scratchSlots = {};
  ctx.previewVisitSerial++;
}

/** Adopt the captured continuation on committed files, or an exact historical image. */
export function adoptResumePoint(
  ctx: WorkerContext,
  boot: HistoryBoot,
  options: {
    currentFiles: boolean;
    paused: boolean;
    cycle?: number;
    tick?: number;
    debug?: boolean;
    returnToPlay?: boolean;
    from?: { segment: string; seq: number; tick: number } | null;
  },
): void {
  if (!ctx.run.owner.active) throw new Error("Take back to play this game.");
  const recordedFiles = new Map(
    Object.entries(boot.files).map(([name, data]) => [name, base64ToBytes(data)]),
  );
  const files = options.currentFiles ? ctx.run.engine!.containerFiles : recordedFiles;
  const profile = options.currentFiles ? ctx.run.engine!.profile : boot.profile;
  if (
    options.currentFiles &&
    boot.profile !== undefined &&
    boot.profile !== ctx.run.engine!.profile.id
  )
    throw new Error("The interpreter profile changed.");
  const dictionary = options.currentFiles
    ? files.get("WORDS.TOK")
      ? stageDictionary(files.get("WORDS.TOK")!)
      : new Map<string, number>()
    : new Map(boot.dictionary);
  const facade = detachedHost(ctx, boot.soundDevice);
  const candidate = new Engine(
    openContainer(files, profile ? { profile } : {}),
    facade.host,
    dictionary,
    {
      ...(profile ? { profile } : {}),
      amigaRegion: boot.amigaRegion ?? "ntsc",
    },
  );
  if (options.currentFiles && boot.image !== undefined) {
    const state = decodeSave(decodeHostImage(base64ToBytes(boot.image)).image, candidate.profile);
    const after = openContainer(files, { profile: candidate.profile });
    if (!after.getResource("logic", state.vars[0]!))
      throw new Error(`Room ${state.vars[0]} needs a LOGIC.`);
    // Native replay loads are required even when a later pair discards the resource.
    for (const pair of state.replay) {
      const kind = pair.kind === 1 ? "view" : pair.kind === 3 ? "sound" : null;
      if (kind && !after.getResource(kind, pair.value))
        throw new Error(`${kind.toUpperCase()} ${pair.value} was removed.`);
    }
    for (const num of boot.replay?.viewCache.loaded ?? [])
      if (!after.getResource("view", num)) throw new Error(`VIEW ${num} was removed.`);
    if (boot.replay?.sound && !after.getResource("sound", boot.replay.sound.num))
      throw new Error(`SOUND ${boot.replay.sound.num} was removed.`);
    const old = new Engine(
      openContainer(recordedFiles, { profile: candidate.profile }),
      facade.host,
      new Map(),
      { profile: candidate.profile },
    );
    if (candidate.readState().inventory.length < old.readState().inventory.length)
      throw new Error("OBJECT has fewer items.");
    const before = openContainer(recordedFiles, { profile: candidate.profile });
    for (const entry of state.logicResume) {
      if (
        entry.offset !== 0 &&
        fnv1a32(before.getResource("logic", entry.logic) ?? new Uint8Array()) !==
          fnv1a32(after.getResource("logic", entry.logic) ?? new Uint8Array())
      )
        throw new Error(`LOGIC ${entry.logic} changed after scan.start.`);
    }
  }
  if (boot.image !== undefined)
    candidate.restoreImage(base64ToBytes(boot.image), { preservePresentation: true });
  else candidate.flags[9] = 1;
  if (boot.menus !== undefined) candidate.restoreMenuState(boot.menus);
  if (boot.replay !== undefined)
    candidate.restoreReplayState({
      ...boot.replay,
      patchGeneration: options.currentFiles
        ? ctx.run.engine!.patchGeneration
        : boot.replay.patchGeneration,
    });
  if (!options.currentFiles) {
    if (boot.fingerprint.v !== HISTORY_FINGERPRINT_VERSION)
      throw new Error(`History fingerprint ${boot.fingerprint.v} is unavailable.`);
    const semantic = historyBootSemantic(boot);
    if (semantic.image !== undefined) {
      const image = candidate.recordingImage();
      if (!image) throw new Error("The saved moment needs a completed checkpoint.");
      semantic.image = bytesToBase64(image);
    }
    if (semantic.replay !== undefined) semantic.replay = candidate.captureReplayState();
    if (semantic.menus !== undefined) semantic.menus = candidate.readMenuState();
    if (historyFingerprint(semantic).hash !== boot.fingerprint.hash)
      throw new Error("The saved moment could not be reproduced.");
  }
  const project = options.currentFiles ? ctx.boot.project : boot.project;
  const admission = ctx.projectLoader.prepareReplacement?.(candidate, project) ?? null;
  const run = ctx.run;
  const lane = admission?.lane ?? null;
  const carriedAdmission =
    options.currentFiles && run.projectAdmission && lane
      ? {
          ...lane,
          runToken: run.projectAdmission.runToken,
          epoch: run.projectAdmission.epoch,
          updateSerial: run.projectAdmission.updateSerial,
          highWater: run.projectAdmission.highWater,
          results: run.projectAdmission.results,
        }
      : lane;
  replaceRun(ctx, options.currentFiles ? "resume" : "history", {
    engine: candidate,
    admission:
      carriedAdmission ??
      (run.projectAdmission
        ? { ...run.projectAdmission, engine: candidate, epoch: run.projectAdmission.epoch + 1 }
        : null),
    project: admission?.project ?? project,
    dictionary,
    ...(options.returnToPlay ? { progress: { mode: "play" }, scratchSlots: {} } : {}),
    settings: {
      authorRooms: boot.authorRooms,
      createAllowed: ctx.boot.createAllowed,
      selectedSoundDevice: boot.soundDevice === 0 ? 0 : 1,
    },
    ...(options.debug
      ? { debug: true, debugSession: ctx.fns.prepareDebugReplacement(candidate) }
      : {}),
    rng: { word: boot.rng, policy: structuredClone(boot.rngPolicy ?? { kind: "external" }) },
    paused: options.paused,
    activate: facade.activate,
    resume: {
      boot,
      cycle: options.cycle ?? run.cycle.cycleCount,
      tick: options.tick ?? run.cycle.tickCount,
      initialLogicStarted: boot.image !== undefined,
    },
  });
  ctx.history.resumedFrom = options.from ?? null;
  ctx.fns.setKeyWaiting(candidate.awaitingKey);
  ctx.fns.historyResume();
  ctx.fns.postFrame(true);
}

export function returnToPlay(ctx: WorkerContext, restart = false): void {
  const progress = ctx.run.progress;
  if (progress.mode === "play") return;
  if (restart) {
    const prepared = prepareRoomLaunch(ctx, { room: 0, beginning: true });
    replaceRun(ctx, "beginning", {
      engine: prepared.engine,
      admission: ctx.run.projectAdmission
        ? { ...ctx.run.projectAdmission, engine: prepared.engine }
        : null,
      project: ctx.boot.project,
      rng: prepared.rng,
      activate: prepared.activate,
      paused: false,
      progress: { mode: "play" },
      scratchSlots: {},
    });
    runRoomLaunch(ctx, prepared);
    ctx.fns.autosave(true);
    return;
  }
  try {
    adoptResumePoint(ctx, progress.returnPoint, {
      currentFiles: true,
      paused: progress.returnPoint.clock?.paused ?? false,
      cycle: progress.cycle,
      tick: progress.tick,
      returnToPlay: true,
    });
  } catch (cause) {
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)} Choose Restart to play from the beginning.`,
      { cause },
    );
  }
  ctx.previewVisitSerial++;
  ctx.fns.autosave(true);
}
