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
import { roomResourcesChanged } from "./roomChange.ts";
import type { WorkerContext } from "./context.ts";

const SILENT_HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

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
    true,
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
    /**
     * Restore the moment on the files it was captured with, then enter its
     * room on the current ones: for a picture whose replay names parts the
     * edited files no longer have, when the room's own parts changed.
     */
    freshEntry?: boolean;
    from?: { segment: string; seq: number; tick: number } | null;
  },
): void {
  if (!ctx.run.owner.active) throw new Error("Take back to play this game.");
  const recordedFiles = new Map(
    Object.entries(boot.files).map(([name, data]) => [name, base64ToBytes(data)]),
  );
  const live = options.currentFiles ? ctx.run.engine!.containerFiles : recordedFiles;
  const files = options.freshEntry ? recordedFiles : live;
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
  if (options.currentFiles) {
    // A message still waiting keeps refusing a changed LOGIC, fresh entry or not.
    const after = openContainer(live, { profile: candidate.profile });
    const imageContinuation =
      boot.image === undefined ? null : decodeHostImage(base64ToBytes(boot.image)).continuation;
    for (const continuation of [imageContinuation, boot.replay?.continuation]) {
      for (const frame of continuation?.frames ?? []) {
        const logic = after.getResource("logic", frame.logic);
        if (!logic || fnv1a32(logic) !== frame.hash)
          throw new Error(`LOGIC ${frame.logic} changed while the game waited.`);
      }
    }
  }
  const restoreOnto = (engine: Engine) => {
    if (boot.image !== undefined)
      engine.restoreImage(base64ToBytes(boot.image), { preservePresentation: true });
    else engine.flags[9] = 1;
    if (boot.menus !== undefined) engine.restoreMenuState(boot.menus);
    if (boot.replay !== undefined)
      engine.restoreReplayState({
        ...boot.replay,
        patchGeneration: options.currentFiles
          ? ctx.run.engine!.patchGeneration
          : boot.replay.patchGeneration,
      });
  };
  restoreOnto(candidate);
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
  let entryPlan: ReturnType<Engine["prepareRoomReentry"]> | null = null;
  if (options.freshEntry) {
    if (!roomResourcesChanged(candidate, recordedFiles, live))
      throw new Error("The room's own parts did not change.");
    // A silent copy proves the entry commits before the live run is replaced.
    const trial = new Engine(
      openContainer(files, profile ? { profile } : {}),
      SILENT_HOST,
      new Map(dictionary),
      { ...(profile ? { profile } : {}), amigaRegion: boot.amigaRegion ?? "ntsc" },
    );
    restoreOnto(trial);
    const tried = trial.commitRoomReentry(trial.prepareRoomReentry({ files: live }));
    if (tried.status !== "committed")
      throw new Error(tried.reason ?? "The room could not start fresh.");
    entryPlan = candidate.prepareRoomReentry({ files: live });
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
      authorRooms: options.currentFiles ? ctx.boot.authorRooms : boot.authorRooms,
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
  if (entryPlan === null) return;
  // The resumed segment ends on the captured files; the entry on the current
  // ones opens the next, as an applied change that enters the room does.
  const entered = candidate.commitRoomReentry(entryPlan, () => {
    ctx.fns.historyEnd("resume");
    ctx.fns.setKeyWaiting(false);
    ctx.fns.abandonHostRequest();
    ctx.fns.markReenter();
  });
  if (entered.status !== "committed")
    throw new Error(entered.reason ?? "The room could not start fresh.");
  ctx.fns.noteTransition();
  ctx.fns.historyResume();
  ctx.fns.postFrame(true);
}

/**
 * Play continues from the moment Create captured, on the current files. A
 * change to what that room has in use re-enters it, so Play shows the change;
 * the result names the room that started fresh.
 */
export function returnToPlay(ctx: WorkerContext, restart = false): { restartedRoom?: number } {
  const progress = ctx.run.progress;
  if (progress.mode === "play") return {};
  if (ctx.replay.replay || ctx.view.drive)
    throw new Error("Play needs the live game. Leave the replay or history view first.");
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
      paused: ctx.livePause,
      progress: { mode: "play" },
      scratchSlots: {},
    });
    runRoomLaunch(ctx, prepared);
    ctx.fns.autosave(true);
    return {};
  }
  // The pause holds belong to the page, not to the captured moment, and the
  // page never hears of a restored pause.
  const options = {
    currentFiles: true,
    paused: ctx.livePause,
    cycle: progress.cycle,
    tick: progress.tick,
    returnToPlay: true,
  };
  let fresh = false;
  try {
    adoptResumePoint(ctx, progress.returnPoint, options);
  } catch (cause) {
    // The captured picture may not replay on the edited files. When the room's
    // own parts changed, it starts fresh from the captured moment instead.
    try {
      if (progress.returnPoint.image === undefined) throw cause;
      adoptResumePoint(ctx, progress.returnPoint, { ...options, freshEntry: true });
      fresh = true;
    } catch {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)} Choose Restart to play from the beginning.`,
        { cause },
      );
    }
  }
  const engine = ctx.run.engine!;
  const captured = new Map(
    Object.entries(progress.returnPoint.files).map(([name, data]) => [name, base64ToBytes(data)]),
  );
  // A cold return point boots the edited files from the start: no room ran yet.
  const restarted =
    fresh ||
    (progress.returnPoint.image !== undefined &&
      roomResourcesChanged(engine, captured, engine.containerFiles));
  if (restarted && !fresh) ctx.fns.onReenter({ type: "reenter" });
  ctx.previewVisitSerial++;
  ctx.fns.autosave(true);
  return restarted ? { restartedRoom: engine.vars[0]! } : {};
}
