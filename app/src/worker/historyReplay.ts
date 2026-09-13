/**
 * Offline history replay: rebuild a scratch session from a segment's boot
 * record — or any recorded anchor — and drive it with the recorded event
 * stream at the recorded ticks. A host answer resumes execution before the
 * next tick, same-tick keys keep queue order, and a patch applies at its
 * recorded boundary, never to the boot resources the earlier tape ran on.
 *
 * The scratch session runs on a real Engine under a fake-port context in
 * replay mode: deterministic LCG randomness, inert journal and recorder,
 * prompts resolved by the recorded answers (historyReplay keeps the live
 * host-request path the walkthrough's key-driven dialogs replace).
 *
 * Every recorded sync mark is verified as it is crossed; the first mismatch
 * — or a mark that can never be reached — is reported as divergence.
 */
import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { GameContainer } from "../../../src/types.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { base64ToBytes } from "../bytes.ts";
import {
  computeSyncMark,
  type HistoryAnchor,
  type HistoryCommittedPatch,
  type HistoryEvent,
  type HistorySegment,
  type HistorySyncMark,
} from "../../../src/agent/history.ts";
import { resourceSetRevision } from "../../../src/agent/authoringState.ts";
import { createWorkerContext, type WorkerContext, type WorkerPorts } from "./context.ts";
import { createEngineHost } from "./host.ts";
import type { WorkerControl, WorkerPresentation } from "../workerProtocol.ts";

export interface HistoryDivergence {
  /** The recorded mark that failed — or the event the stream stranded. */
  at: { seq: number; tick: number; cycle: number };
  detail: string;
  expected?: string;
  actual?: string;
}

export interface HistoryReplayOutcome {
  /** The scratch session's context — inspectable after the run. */
  ctx: WorkerContext;
  /** Events applied. */
  applied: number;
  /** First verification failure, or null when every mark held. */
  diverged: HistoryDivergence | null;
  /** A thrown boundary or structurally unusable recording. */
  error: string | null;
  /** Presentation traffic, when collectPresentation was set. */
  presented: WorkerPresentation[];
  /** Control traffic (hostRequests the recorded answers resolve, notices). */
  controlled: WorkerControl[];
}

export interface HistoryReplayOptions {
  /** Start from this anchor index instead of the segment's boot. */
  anchor?: number;
  /** Apply events only through this seq (exclusive) — the scrub primitive. */
  toSeq?: number;
  /** Virtual ticks to run past the stream's end after the last event. */
  tailTicks?: number;
  /** Bound on virtual ticks so a corrupt stream cannot run forever. */
  maxTicks?: number;
  collectPresentation?: boolean;
}

/** Fold container mutations the recorded events committed before `seq`. */
function foldFiles(
  container: GameContainer,
  dictionary: Map<string, number>,
  events: readonly HistoryEvent[],
  seq: number,
): { wordsPatched: boolean } {
  let wordsPatched = false;
  const applyCommitted = (patch: HistoryCommittedPatch): void => {
    for (const r of patch.resources) container.putResource(r.kind, r.num, base64ToBytes(r.data));
    if (patch.words !== undefined) {
      const words = base64ToBytes(patch.words);
      dictionary.clear();
      for (const { word, id } of parseWordsTok(words)) dictionary.set(word, id);
      container.putFile("WORDS.TOK", words);
      wordsPatched = true;
    }
    if (patch.object !== undefined) container.putFile("OBJECT", base64ToBytes(patch.object));
    if (patch.tests !== undefined) container.putFile("TESTS.JSON", base64ToBytes(patch.tests));
  };
  for (const event of events) {
    if (event.seq >= seq) break;
    const cause = event.cause;
    if (cause.kind === "patch")
      container.putResource(cause.resource, cause.num, base64ToBytes(cause.data));
    else if (cause.kind === "patchMeta") {
      if (cause.words !== undefined) {
        const words = base64ToBytes(cause.words);
        dictionary.clear();
        for (const { word, id } of parseWordsTok(words)) dictionary.set(word, id);
        container.putFile("WORDS.TOK", words);
        wordsPatched = true;
      }
      if (cause.object !== undefined) container.putFile("OBJECT", base64ToBytes(cause.object));
      if (cause.tests !== undefined) container.putFile("TESTS.JSON", base64ToBytes(cause.tests));
    } else if (cause.kind === "answer" && cause.patch !== undefined && cause.prepared === true) {
      applyCommitted(cause.patch);
    }
  }
  return { wordsPatched };
}

/** Ports the drive's scratch session posts through; `now` stays drive-owned. */
export interface HistoryDrivePorts {
  control?(message: WorkerControl): void;
  presentation?(message: WorkerPresentation, transfer?: Transferable[]): void;
}

export type HistoryDriveStep = "event" | "tick" | "halt";

/**
 * A persistent scratch replay: the same verification loop
 * `replayHistorySegment` runs, but incremental — the view session steps it
 * in wall-clock-budgeted chunks so a long seek never starves the worker.
 */
export interface HistoryDrive {
  /** The scratch session's context — inspectable during and after the run. */
  readonly ctx: WorkerContext;
  /** Events applied so far. */
  readonly applied: number;
  /** First verification failure, or null when every mark held. */
  readonly diverged: HistoryDivergence | null;
  /** A thrown boundary or structurally unusable recording. */
  readonly error: string | null;
  /** The recorded tick the drive sits on (host-poll axis). */
  readonly tick: number;
  /** Seq the stream reached — the next unapplied event, or the end seq. */
  readonly seq: number;
  /** The next unapplied event's tick — Infinity when the stream is spent. */
  readonly nextEventTick: number;
  /** The last tick the recording reaches (end/event/mark max + tailTicks). */
  readonly endTick: number;
  /** The drive can no longer step: done, diverged, or errored. */
  readonly halted: boolean;
  /** One loop iteration: verify due marks, apply a due event, or run one poll. */
  step(): HistoryDriveStep;
}

/**
 * Build the scratch session the drive steps: fold the container mutations
 * the events before the start committed, restore the boot record or the
 * chosen anchor, then replay events at their recorded ticks — identical
 * semantics to the old monolithic replayHistorySegment loop.
 */
export function openHistoryDrive(
  segment: HistorySegment,
  options: HistoryReplayOptions & { ports?: HistoryDrivePorts } = {},
): HistoryDrive {
  const anchor: HistoryAnchor | null =
    options.anchor !== undefined ? (segment.anchors[options.anchor] ?? null) : null;
  const startSeq = anchor ? anchor.seq : 0;
  const startTick = anchor ? anchor.tick : 0;
  const startCycle = anchor ? anchor.cycle : 0;
  const maxTicks = options.maxTicks ?? 10_000_000;
  const toSeq = options.toSeq;

  let virtualNow = (startTick * 1000) / 60;
  const ports: WorkerPorts = {
    control: (message) => options.ports?.control?.(message),
    presentation: (message, transfer) => options.ports?.presentation?.(message, transfer),
    now: () => virtualNow,
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  const outcome = {
    applied: 0,
    diverged: null as HistoryDivergence | null,
    error: null as string | null,
  };
  const fail = (at: { seq: number; tick: number; cycle: number }, detail: string): void => {
    if (outcome.diverged === null) outcome.diverged = { at, detail };
  };

  const events = segment.events;
  let ei = 0;
  let markIdx = 0;
  let finished = false;
  let endSeq = 0;
  let endTick = 0;
  let engine: Engine | null = null;
  let replay: { tick: number; revision: number; random: number } | null = null;
  const appliedSeq = () => (ei < events.length ? events[ei]!.seq : endSeq);
  const nextDue = () =>
    ei < events.length && (toSeq === undefined || events[ei]!.seq < toSeq) ? events[ei]! : null;

  const drive: HistoryDrive = {
    ctx,
    get applied() {
      return outcome.applied;
    },
    get diverged() {
      return outcome.diverged;
    },
    get error() {
      return outcome.error;
    },
    get tick() {
      return replay?.tick ?? startTick;
    },
    get seq() {
      return appliedSeq();
    },
    get nextEventTick() {
      return nextDue()?.tick ?? Infinity;
    },
    get endTick() {
      return endTick;
    },
    get halted() {
      return finished || outcome.error !== null || engine === null;
    },
    step,
  };

  try {
    // Fold every container mutation the events before the start committed.
    const dictionary = new Map(segment.boot.dictionary);
    const baseFiles = new Map<string, Uint8Array>();
    for (const [name, data] of Object.entries(segment.boot.files))
      baseFiles.set(name, base64ToBytes(data));
    const foldContainer = openContainer(baseFiles);
    const { wordsPatched } = foldFiles(foldContainer, dictionary, segment.events, startSeq);
    const files = new Map(foldContainer.files);
    if (anchor && resourceSetRevision({ getFiles: () => files }) !== anchor.resourceSet) {
      outcome.error = `anchor ${anchor.seq} resource set does not match the folded stream`;
      finished = true;
      return drive;
    }

    ctx.boot.liveDictionary = dictionary;
    ctx.boot.currentBootFiles = files;
    ctx.boot.currentDictionary = dictionary;
    ctx.boot.authorRooms = segment.boot.authorRooms;
    ctx.boot.selectedSoundDevice = anchor ? anchor.soundDevice : segment.boot.soundDevice;
    ctx.boot.authoredWords = wordsPatched ? (files.get("WORDS.TOK") ?? null) : null;
    ctx.engine = new Engine(openContainer(files), ctx.host, dictionary);
    ctx.fns.armJournal();
    // Browser sessions boot with game sound enabled; the recorded flag restores below.
    ctx.engine.flags[9] = 1;
    ctx.hostRequests.hostRequestSerial = anchor ? anchor.requestSerial : segment.boot.requestSerial;
    ctx.replay.replay = {
      tick: startTick,
      revision: 0,
      random: anchor ? anchor.rng : segment.boot.rng,
    };
    ctx.replay.historyReplay = true;
    ctx.cycle.cycleCount = startCycle;
    ctx.cycle.tickCount = startTick;

    const image = anchor ? anchor.image : segment.boot.image;
    if (image !== undefined) ctx.engine.restoreImage(base64ToBytes(image));
    const menus = anchor ? undefined : segment.boot.menus;
    if (menus !== undefined) ctx.engine.restoreMenuState(menus);
    const replayState = anchor ? anchor.replay : segment.boot.replay;
    if (replayState !== undefined) ctx.engine.restoreReplayState(replayState);
    ctx.input.keyQueue = [...(anchor ? anchor.inputQueue : (segment.boot.inputQueue ?? []))];
    ctx.input.deferredMovement = [
      ...(anchor ? anchor.directionQueue : (segment.boot.directionQueue ?? [])),
    ];
    ctx.input.inputBuffer = [...(anchor ? anchor.inputLines : (segment.boot.inputLines ?? []))];
    const clock = anchor ? anchor.clock : segment.boot.clock;
    if (clock !== undefined) ctx.clocks.cycle.restore(clock, virtualNow);
    ctx.cycle.paused = clock?.paused ?? false;
    if (ctx.engine.awaitingKey) ctx.fns.setKeyWaiting(true);

    engine = ctx.engine;
    replay = ctx.replay.replay;
    while (ei < events.length && events[ei]!.seq < startSeq) ei++;
    endSeq = segment.end?.seq ?? (events.length ? events[events.length - 1]!.seq + 1 : 0);
    // Marks behind the anchor's position are already-applied history; the mark
    // at the anchor's own position verifies the restore itself. Two anchors
    // may share a seq when no events fall between them, so both axes gate.
    while (
      markIdx < segment.sync.length &&
      (segment.sync[markIdx]!.seq < startSeq || segment.sync[markIdx]!.tick < startTick)
    )
      markIdx++;
    const tailTicks = options.tailTicks ?? 0;
    // Run out the recorded tail: the segment's end tick, the last event, or
    // the last sync mark — whichever the stream reached last.
    endTick =
      Math.max(
        segment.end?.tick ?? 0,
        events.length ? events[events.length - 1]!.tick : 0,
        segment.sync.length ? segment.sync[segment.sync.length - 1]!.tick : 0,
      ) + tailTicks;
  } catch (error) {
    outcome.error = String(error);
    finished = true;
    return drive;
  }

  /** Verify every recorded mark exactly at its (seq, tick) position. */
  function checkMarks(): void {
    while (markIdx < segment.sync.length) {
      const mark: HistorySyncMark = segment.sync[markIdx]!;
      const seqNow = appliedSeq();
      if (seqNow > mark.seq || replay!.tick > mark.tick) {
        fail(
          { seq: mark.seq, tick: mark.tick, cycle: mark.cycle },
          `sync mark unreachable: stream passed it at tick ${replay!.tick} seq ${seqNow}`,
        );
        markIdx++;
        continue;
      }
      if (seqNow !== mark.seq || replay!.tick !== mark.tick) break;
      const actual = computeSyncMark(engine!, mark.seq, mark.tick, mark.cycle);
      markIdx++;
      if (
        actual.digest !== mark.digest ||
        actual.room !== mark.room ||
        actual.score !== mark.score ||
        actual.patchGeneration !== mark.patchGeneration ||
        actual.modal !== mark.modal ||
        ctx.cycle.cycleCount !== mark.cycle
      ) {
        outcome.diverged = {
          at: { seq: mark.seq, tick: mark.tick, cycle: mark.cycle },
          detail: `sync mark mismatch at room ${mark.room} cycle ${ctx.cycle.cycleCount}/${mark.cycle}`,
          expected: mark.digest,
          actual: actual.digest,
        };
      }
      if (outcome.diverged !== null) return;
    }
  }

  function applyEvent(event: HistoryEvent): void {
    const cause = event.cause;
    switch (cause.kind) {
      case "key":
        ctx.fns.onKey({ type: "key", code: cause.code });
        return;
      case "direction":
        ctx.fns.onDirection({ type: "direction", dir: cause.dir });
        return;
      case "release":
        // The live boundary accepted this release; apply it as recorded —
        // re-deriving eligibility from the mirrored gate would second-guess
        // the tape when the host's frame mirror lagged the engine's.
        if (ctx.input.deferredMovement.length < 19) ctx.input.deferredMovement.push(0);
        ctx.fns.flushDeferredMovement();
        return;
      case "input":
        ctx.fns.onInput({ type: "input", text: cause.text });
        return;
      case "edit":
        ctx.fns.onEdit({ type: "edit", text: cause.text });
        return;
      case "dismiss":
        ctx.fns.onDismissPrint();
        return;
      case "pause":
        ctx.fns.onPause({ type: "pause", paused: cause.paused });
        return;
      case "sound":
        engine!.setSoundEnabled(cause.enabled);
        return;
      case "device": {
        const device = cause.device === 0 ? 0 : 1;
        if (device !== ctx.boot.selectedSoundDevice) engine!.stopSoundPlayback();
        ctx.boot.selectedSoundDevice = device;
        engine!.vars[22] = device === 0 ? 1 : 3;
        return;
      }
      case "reenter":
        ctx.fns.onReenter({
          type: "reenter",
          ...(cause.room !== undefined ? { room: cause.room } : {}),
        });
        return;
      case "patch":
        engine!.patchResource(cause.resource, cause.num, base64ToBytes(cause.data));
        return;
      case "patchMeta": {
        const words = cause.words !== undefined ? base64ToBytes(cause.words) : undefined;
        const objects = cause.object !== undefined ? base64ToBytes(cause.object) : undefined;
        const tests = cause.tests !== undefined ? base64ToBytes(cause.tests) : undefined;
        const entries = words ? parseWordsTok(words) : undefined;
        engine!.patchAuxiliaryFiles({
          ...(words ? { words } : {}),
          ...(objects ? { objects } : {}),
          ...(tests ? { tests } : {}),
        });
        if (entries && words) {
          ctx.boot.liveDictionary.clear();
          for (const { word, id } of entries) ctx.boot.liveDictionary.set(word, id);
          ctx.boot.authoredWords = words;
        }
        return;
      }
      case "debugWrite":
        ctx.fns.onDebugWrite({
          type: "debugWrite",
          id: 0,
          ...(cause.vars ? { vars: cause.vars } : {}),
          ...(cause.flags ? { flags: cause.flags } : {}),
        });
        return;
      case "answer":
        if (cause.op === "room")
          ctx.fns.onHostAnswer(
            { type: "hostAnswer", id: cause.request, response: cause.response },
            cause.patch,
          );
        else
          ctx.fns.onHostAnswer({
            type: "hostAnswer",
            id: cause.request,
            response: cause.response,
          });
        return;
      case "restart":
      case "end":
        return; // reproduced by the tick stream / the segment boundary itself
    }
  }

  /**
   * One virtual host poll — structurally identical to the live hostTick: a
   * paused poll only touches the cycle clock; otherwise the sound clock
   * decides how many engine ticks elapsed wall time discharges (a paused
   * stretch backlogs and bursts inside a single recorded tick, exactly as
   * live), then queued keys deliver and either the suspended/modal branch
   * or a cycle poll runs.
   */
  function advanceTick(): void {
    replay!.tick++;
    ctx.cycle.tickCount = replay!.tick;
    virtualNow = (replay!.tick * 1000) / 60;
    if (ctx.cycle.paused) {
      ctx.clocks.cycle.poll(virtualNow, engine!.vars[10]!, true);
      return;
    }
    const soundTicks = ctx.clocks.sound.advance(virtualNow, false);
    for (let i = 0; i < soundTicks; i++) ctx.fns.recordedClock();
    ctx.fns.deliverQueuedKey();
    if (
      engine!.modalKind !== null ||
      engine!.continuationPending ||
      engine!.hostInteractionPending
    ) {
      ctx.fns.tickEngine();
      ctx.fns.noteTransition();
      if (ctx.hostRequests.pendingReenter && !engine!.hostInteractionPending) {
        ctx.hostRequests.pendingReenter = false;
        ctx.journal.pendingCause = null;
        ctx.fns.noteTransition();
      }
    } else if (ctx.clocks.cycle.poll(virtualNow, engine!.vars[10]!)) {
      ctx.fns.flushDeferredMovement();
      ctx.fns.tickEngine();
      ctx.fns.finishCycle();
    }
  }

  /**
   * One iteration of the verification loop: marks first (a mark exactly at
   * the boundary verifies before anything else moves), then a due event,
   * then one poll. Halting runs one final mark pass so marks exactly at the
   * last position still verify.
   */
  function halt(): "halt" {
    if (!finished) {
      finished = true;
      try {
        checkMarks();
      } catch {
        /* the error that halted us is already reported */
      }
    }
    return "halt";
  }

  function step(): HistoryDriveStep {
    if (finished || engine === null || replay === null || outcome.error !== null) return "halt";
    try {
      checkMarks();
      if (outcome.diverged !== null) return halt();
      const event = nextDue();
      if (event !== null && event.tick <= replay.tick) {
        // An answer event resolves the request the replayed engine parked on;
        // the serial check inside onHostAnswer verifies the pairing.
        applyEvent(event);
        ei++;
        outcome.applied++;
        return "event";
      }
      // Nothing left to apply — run out the segment's recorded tail.
      if (event === null && replay.tick >= endTick) return halt();
      // A pending event behind a terminated engine is one the live session
      // could never have produced — report the strand. Paused polls still
      // advance the recorded tick, so a pause is never a strand.
      if (event !== null && engine.readLeanState().terminated) {
        fail(
          { seq: event.seq, tick: event.tick, cycle: event.cycle },
          `recorded event unreachable: replay cannot advance past tick ${replay.tick} — engine terminated`,
        );
        return halt();
      }
      advanceTick();
      if (replay.tick - startTick > maxTicks) {
        outcome.error = `replay exceeded ${maxTicks} virtual ticks`;
        return halt();
      }
      return "tick";
    } catch (error) {
      outcome.error = String(error);
      return halt();
    }
  }

  return drive;
}

/** Run a whole segment synchronously — the offline proof and verifier. */
export function replayHistorySegment(
  segment: HistorySegment,
  options: HistoryReplayOptions = {},
): HistoryReplayOutcome {
  const presented: WorkerPresentation[] = [];
  const controlled: WorkerControl[] = [];
  const drive = openHistoryDrive(segment, {
    ...options,
    ports: {
      control: (message) => controlled.push(message),
      presentation: (message) => {
        if (options.collectPresentation) presented.push(message);
      },
    },
  });
  while (!drive.halted) drive.step();
  return {
    ctx: drive.ctx,
    applied: drive.applied,
    diverged: drive.diverged,
    error: drive.error,
    presented,
    controlled,
  };
}
