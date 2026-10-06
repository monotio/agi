import type { Engine, EngineHost } from "../../../src/runtime/engine.ts";
import type {
  HistoryBoot,
  HistoryEndReason,
  HistoryProjectDocuments,
} from "../../../src/agent/history.ts";
import type { HostRngState } from "../../../src/runtime/rng.ts";
import type { ProjectAdmissionState } from "./projectAdmissionState.ts";
import type { RunSession, WorkerContext } from "./context.ts";
import { resetRecording, configureSessionTiming } from "./session.ts";

import { newRunSession } from "./runState.ts";
import type { PreviewPreparedSession } from "./debuggerState.ts";

export type ReplacementKind =
  "boot" | "launch" | "beginning" | "restart" | "resume" | "history" | "replay";
const REPLACEMENTS: Record<
  ReplacementKind,
  {
    journal: "carry" | "cold" | "adopt";
    cause: "jump" | "restart" | null;
    freshProgress: boolean;
    freshSerial: boolean;
    end: HistoryEndReason;
  }
> = {
  boot: { journal: "cold", cause: null, freshProgress: true, freshSerial: true, end: "boot" },
  launch: {
    journal: "carry",
    cause: "jump",
    freshProgress: false,
    freshSerial: false,
    end: "boot",
  },
  beginning: {
    journal: "cold",
    cause: "restart",
    freshProgress: false,
    freshSerial: false,
    end: "boot",
  },
  restart: {
    journal: "cold",
    cause: "restart",
    freshProgress: false,
    freshSerial: false,
    end: "boot",
  },
  resume: {
    journal: "adopt",
    cause: null,
    freshProgress: false,
    freshSerial: false,
    end: "resume",
  },
  history: {
    journal: "adopt",
    cause: null,
    freshProgress: false,
    freshSerial: false,
    end: "resume",
  },
  replay: {
    journal: "adopt",
    cause: null,
    freshProgress: false,
    freshSerial: false,
    end: "walkthrough",
  },
};
export interface PreparedRun {
  engine: Engine;
  admission: ProjectAdmissionState | null;
  project: HistoryProjectDocuments | undefined;
  rng: HostRngState;
  progress?: RunSession["progress"];
  scratchSlots?: RunSession["scratchSlots"];
  settings?: Pick<WorkerContext["boot"], "authorRooms" | "createAllowed" | "selectedSoundDevice">;
  autosave?: Pick<RunSession["autosave"], "autosaveIntervalMs" | "autosaveFiles">;
  activate?: () => void;
  dictionary?: Map<string, number>;
  replay?: WorkerContext["replay"];
  debug?: boolean;
  debugSession?: PreviewPreparedSession;
  resume?: {
    boot: Pick<
      HistoryBoot,
      | "requestSerial"
      | "inputQueue"
      | "directionQueue"
      | "inputLines"
      | "clickQueue"
      | "clock"
      | "soundRemainder"
    >;
    cycle: number;
    tick: number;
    virtualNow?: number;
    initialLogicStarted?: boolean;
  };
  paused: boolean;
}

/** Candidate restoration has no live sound, input or host-question side effects. */
export function detachedHost(
  ctx: WorkerContext,
  soundDevice = ctx.boot.selectedSoundDevice,
): { host: EngineHost; activate(): void } {
  let active = false;
  const host: EngineHost = new Proxy(ctx.host, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (active) return Reflect.apply(value, target, args);
        if (key === "soundDevice") return soundDevice;
        if (key === "takeKeys" || key === "takePointerClicks") return [];
        if (key === "prepareRoom") return true;
        return null;
      };
    },
  });
  return {
    host,
    activate() {
      active = true;
    },
  };
}

/** Install one completely validated run; durable history delivery remains project-owned. */
export function replaceRun(ctx: WorkerContext, kind: ReplacementKind, prepared: PreparedRun): void {
  const prior = ctx.run;
  const policy = REPLACEMENTS[kind];
  const scheduling = prior.cycle.timer !== null || prior.cycle.soundTimer !== null;
  const progress =
    prepared.progress ?? (policy.freshProgress ? { mode: "play" as const } : prior.progress);
  const scratchSlots = prepared.scratchSlots ?? (policy.freshProgress ? {} : prior.scratchSlots);
  const journal =
    policy.journal === "carry"
      ? {
          ...prior.journal,
          pending: [],
          pendingCause: policy.cause,
        }
      : {
          seq: kind === "boot" ? 0 : prior.journal.seq,
          lastRoom: null,
          lastScore: 0,
          lastCarried: [],
          pending: [],
          pendingCause: policy.cause,
        };
  ctx.fns.onHistoryViewEnd();
  ctx.fns.historyEnd(policy.end);
  ctx.fns.debugBeforeReplace();
  prior.engine?.stopSound();
  if (prior.engine?.hostInteractionPending) prior.engine.abortInteraction();
  ctx.fns.setKeyWaiting(false);
  ctx.fns.abandonHostRequest();
  ctx.fns.stopTimers();
  resetRecording(ctx);
  ctx.previewVisitSerial++;
  ctx.imageHeroPreview = undefined;
  ctx.imagePreviewEngine = undefined;
  ctx.imagePreviewSerial = (ctx.imagePreviewSerial ?? 0) + 1;
  const fresh = newRunSession(ctx.ports.now());
  ctx.run = {
    ...fresh,
    generation: prior.generation + 1,
    owner: { ...prior.owner, answers: [] },
    engine: prepared.engine,
    projectAdmission: prepared.admission,
    progress,
    scratchSlots,
    rng: structuredClone(prepared.rng),
    journal,
    debugger: prior.debugger,
    autosave: {
      ...fresh.autosave,
      ...(prepared.autosave ?? {
        autosaveIntervalMs: prior.autosave.autosaveIntervalMs,
        autosaveFiles: prior.autosave.autosaveFiles,
      }),
    },
    debug: {
      ...fresh.debug,
      channels: { ...prior.debug.channels },
      traceEpoch: prior.debug.traceEpoch + 1,
    },
    input: { ...fresh.input, observeSentences: prior.input.observeSentences },
    hostRequests: {
      ...fresh.hostRequests,
      hostRequestSerial: policy.freshSerial ? 0 : prior.hostRequests.hostRequestSerial,
    },
  };
  const run = ctx.run;
  if (prepared.replay) ctx.replay = prepared.replay;
  const boot = prepared.resume?.boot;
  ctx.boot.currentBootFiles = new Map(run.engine!.containerFiles);
  ctx.boot.profile = run.engine!.profile.id;
  ctx.boot.authoredWords = null;
  if (prepared.dictionary) {
    ctx.boot.liveDictionary = prepared.dictionary;
    ctx.boot.currentDictionary = prepared.dictionary;
  }
  ctx.boot.project = prepared.project;
  if (prepared.settings) Object.assign(ctx.boot, prepared.settings);
  configureSessionTiming(ctx);
  const clockNow = ctx.replay.replay ? (prepared.resume?.virtualNow ?? 0) : ctx.ports.now();
  run.clocks.cycle.reset(clockNow);
  run.clocks.sound.reset(clockNow);
  run.cycle.paused = prepared.paused;
  if (boot) {
    run.cycle.cycleCount = prepared.resume!.cycle;
    run.cycle.tickCount = prepared.resume!.tick;
    run.cycle.initialLogicStarted = prepared.resume!.initialLogicStarted ?? true;
    run.hostRequests.hostRequestSerial = boot.requestSerial;
    run.input.keyQueue = [...(boot.inputQueue ?? [])];
    run.input.deferredMovement = [...(boot.directionQueue ?? [])];
    run.input.inputBuffer = [...(boot.inputLines ?? [])];
    run.input.clickQueue = (boot.clickQueue ?? []).map(([x, y]) => [x, y]);
    const now = prepared.resume!.virtualNow ?? ctx.ports.now();
    if (prepared.resume!.virtualNow !== undefined && boot.clock)
      run.clocks.cycle.restore(boot.clock, now);
    else run.cycle.pendingClock = boot.clock ?? null;
    if (boot.soundRemainder !== undefined) run.clocks.sound.restore(now, boot.soundRemainder);
  }
  run.input.keyWaiting = prepared.engine.awaitingKey;
  run.autosave.lastAutosaveAt = ctx.ports.now();
  run.autosave.lastAutosaveCycle = -1;
  run.autosave.lastPatchGeneration = prepared.engine.patchGeneration;
  prepared.activate?.();
  if (prepared.debugSession) ctx.fns.previewSessionInstall(prepared.debugSession);
  ctx.fns.debugSessionReplaced(prepared.debug);
  ctx.fns.armJournal();
  if (policy.journal === "adopt") ctx.fns.rebaselineJournal();
  ctx.fns.applyTraceChannel();
  ctx.fns.captureStateDiffs();
  if (scheduling && !ctx.replay.replay) ctx.fns.startTimers();
}
