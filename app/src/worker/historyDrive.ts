import { configureSessionTiming } from "./session.ts";
/**
 * The scratch tape drive (`openHistoryDrive`): rebuild a session from a
 * segment's boot or anchor, apply the recorded event stream at its recorded
 * ticks, and verify every sync mark it crosses. It steps on replay.ts's
 * virtual host poll.
 *
 * The scratch session runs on a real Engine under a fake-port context in
 * replay mode: deterministic LCG randomness, inert journal and recorder,
 * prompts resolved by the recorded answers (historyReplay keeps the live
 * host-request path the walkthrough's key-driven dialogs replace). The
 * caller supplies the context factory — context.ts's createWorkerContext —
 * so this module never imports the context it runs inside.
 */
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { HistoryProjectDocuments } from "../../../src/agent/history.ts";
import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { GameContainer } from "../../../src/types.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { base64ToBytes, bytesToBase64 } from "../project/bytes.ts";
import {
  computeSyncMark,
  HISTORY_FINGERPRINT_VERSION,
  historyAnchorSemantic,
  historyBootSemantic,
  historyFingerprint,
  type HistoryAnchor,
  type HistoryCommittedPatch,
  type HistoryEvent,
  type HistorySemanticState,
  type HistorySegment,
  type HistorySyncMark,
} from "../../../src/agent/history.ts";
import { resourceSetHint } from "../../../src/agent/authoringState.ts";
import type { WorkerContext, WorkerPorts } from "./context.ts";
import { createEngineHost } from "./host.ts";
import { replayTick } from "./replay.ts";
import type { WorkerControl, WorkerPresentation } from "./workerProtocol.ts";

interface HistoryDivergence {
  /** The recorded mark that failed — or the event the stream stranded. */
  at: { seq: number; tick: number; cycle: number };
  detail: string;
  expected?: string;
  actual?: string;
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
}

/** Fold container mutations the recorded events committed before `seq`. */
function foldFiles(
  container: GameContainer,
  dictionary: Map<string, number>,
  events: readonly HistoryEvent[],
  seq: number,
  profile: ProfileId | undefined,
  initialProject: HistoryProjectDocuments | undefined,
): {
  project: HistoryProjectDocuments | undefined;
  wordsPatched: boolean;
  files: ReadonlyMap<string, Uint8Array>;
} {
  let wordsPatched = false;
  let project = initialProject;
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
    if (cause.kind === "projectImage") {
      container = openContainer(
        new Map(Object.entries(cause.files).map(([name, data]) => [name, base64ToBytes(data)])),
        profile === undefined ? {} : { profile },
      );
      project = { documents: cause.documents, documentId: cause.documentId };
      const words = container.files.get("WORDS.TOK");
      if (words !== undefined) {
        dictionary.clear();
        for (const { word, id } of parseWordsTok(words)) dictionary.set(word, id);
        wordsPatched = true;
      }
    } else if (cause.kind === "patch")
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
  return { project, wordsPatched, files: container.files };
}

/** Ports the drive's scratch session posts through; `now` stays drive-owned. */
export interface HistoryDrivePorts {
  control?(message: WorkerControl): void;
  presentation?(message: WorkerPresentation, transfer?: Transferable[]): void;
}

type HistoryDriveStep = "event" | "tick" | "halt";

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
 * Re-derive a resume point's semantic record from the restored scratch
 * session — the same fields the fingerprint covers, taken from the live
 * objects, not the record itself. A field the record carries but the
 * restored state cannot produce (an image that no longer snapshots) is a
 * failure, not an omission.
 */
function captureSemanticState(
  ctx: WorkerContext,
  template: HistorySemanticState,
): HistorySemanticState {
  const engine = ctx.engine;
  if (engine === null) throw new Error("no engine to capture");
  const files = new Map(engine.containerFiles);
  if (ctx.boot.authoredWords) files.set("WORDS.TOK", ctx.boot.authoredWords);
  const out: HistorySemanticState = {
    requestSerial: ctx.hostRequests.hostRequestSerial,
    rng: ctx.replay.replay?.random ?? 0,
    soundDevice: ctx.boot.selectedSoundDevice,
    resourceSet: resourceSetHint({ getFiles: () => files }),
  };
  if (template.amigaRegion !== undefined) out.amigaRegion = engine.amigaRegion;
  if (template.documentId !== undefined) {
    if (ctx.boot.project === undefined)
      throw new Error("project documents are missing at the restored boundary");
    out.documentId = ctx.boot.project.documentId;
  }
  if (template.authorRooms !== undefined) out.authorRooms = ctx.boot.authorRooms;
  if (template.dictionary !== undefined)
    out.dictionary = [...ctx.boot.liveDictionary.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  if (template.image !== undefined) {
    const image = engine.recordingImage();
    if (image === null) throw new Error("the restored state is not a resumable boundary");
    out.image = bytesToBase64(image);
  }
  if (template.replay !== undefined) out.replay = engine.captureReplayState();
  if (template.menus !== undefined) out.menus = engine.readMenuState();
  if (template.inputQueue !== undefined) out.inputQueue = [...ctx.input.keyQueue];
  if (template.directionQueue !== undefined) out.directionQueue = [...ctx.input.deferredMovement];
  if (template.inputLines !== undefined) out.inputLines = [...ctx.input.inputBuffer];
  if (template.clickQueue !== undefined)
    out.clickQueue = ctx.input.clickQueue.map(([x, y]): [number, number] => [x, y]);
  if (template.clock !== undefined) out.clock = ctx.clocks.cycle.snapshot();
  if (template.soundRemainder !== undefined) out.soundRemainder = ctx.clocks.sound.snapshot();
  if (template.patchGeneration !== undefined) out.patchGeneration = engine.patchGeneration;
  return out;
}

/**
 * Build the scratch session the drive steps: fold the container mutations
 * the events before the start committed, restore the boot record or the
 * chosen anchor, then replay events at their recorded ticks.
 */
export function openHistoryDrive(
  segment: HistorySegment,
  createContext: (ports: WorkerPorts) => WorkerContext,
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
  const ctx = createContext(ports);
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
    const foldContainer = openContainer(
      baseFiles,
      segment.boot.profile ? { profile: segment.boot.profile } : {},
    );
    const {
      wordsPatched,
      files: foldedFiles,
      project,
    } = foldFiles(
      foldContainer,
      dictionary,
      segment.events,
      startSeq,
      segment.boot.profile,
      segment.boot.project,
    );
    const files = new Map(foldedFiles);
    const recordedSet = anchor ? anchor.resourceSet : segment.boot.resourceSet;
    if (resourceSetHint({ getFiles: () => files }) !== recordedSet) {
      outcome.error =
        anchor !== null
          ? `anchor ${anchor.seq} resource set does not match the folded stream`
          : "boot resource set does not match its recorded files";
      finished = true;
      return drive;
    }

    ctx.boot.project = project;
    ctx.boot.liveDictionary = dictionary;
    ctx.boot.currentBootFiles = files;
    ctx.boot.currentDictionary = dictionary;
    ctx.boot.authorRooms = segment.boot.authorRooms;
    ctx.boot.selectedSoundDevice = anchor ? anchor.soundDevice : segment.boot.soundDevice;
    ctx.boot.authoredWords = wordsPatched ? (files.get("WORDS.TOK") ?? null) : null;
    ctx.boot.profile = segment.boot.profile ?? null;
    ctx.boot.amigaRegion = segment.boot.amigaRegion ?? "ntsc";
    ctx.engine = new Engine(
      openContainer(files, ctx.boot.profile ? { profile: ctx.boot.profile } : {}),
      ctx.host,
      dictionary,
      {
        ...(ctx.boot.profile ? { profile: ctx.boot.profile } : {}),
        amigaRegion: ctx.boot.amigaRegion,
      },
    );
    ctx.fns.armJournal();
    // Browser sessions boot with game sound enabled; the recorded flag restores below.
    ctx.engine.flags[9] = 1;
    ctx.hostRequests.hostRequestSerial = anchor ? anchor.requestSerial : segment.boot.requestSerial;
    ctx.replay.replay = {
      tick: startTick,
      revision: 0,
      random: anchor ? anchor.rng : segment.boot.rng,
    };
    // The recorded BIOS-clock lane: every reseed the live session drew at
    // or after the start position, in draw order — the scratch RNG's
    // zero-state reads drain it. Events before the anchor were consumed
    // by draws the replay never re-runs.
    ctx.replay.reseeds = events
      .filter((e) => e.seq >= startSeq && e.cause.kind === "reseed")
      .map((e) => (e.cause as { kind: "reseed"; value: number }).value);
    ctx.replay.reseedCursor = 0;
    ctx.replay.historyReplay = true;
    ctx.cycle.cycleCount = startCycle;
    ctx.cycle.tickCount = startTick;

    const image = anchor ? anchor.image : segment.boot.image;
    // The recorded presentation is the state at this resume point — the
    // live-restore redraw (status and input rows re-stamped) would rewrite
    // the text ages the snapshot carries.
    if (image !== undefined)
      ctx.engine.restoreImage(base64ToBytes(image), { preservePresentation: true });
    const menus = anchor ? undefined : segment.boot.menus;
    if (menus !== undefined) ctx.engine.restoreMenuState(menus);
    const replayState = anchor ? anchor.replay : segment.boot.replay;
    if (replayState !== undefined) ctx.engine.restoreReplayState(replayState);
    ctx.input.keyQueue = [...(anchor ? anchor.inputQueue : (segment.boot.inputQueue ?? []))];
    ctx.input.deferredMovement = [
      ...(anchor ? anchor.directionQueue : (segment.boot.directionQueue ?? [])),
    ];
    ctx.input.inputBuffer = [...(anchor ? anchor.inputLines : (segment.boot.inputLines ?? []))];
    // The queue is optional on pre-click tapes; an anchor lacking it means
    // empty, never the boot's leftovers.
    ctx.input.clickQueue = (
      anchor ? (anchor.clickQueue ?? []) : (segment.boot.clickQueue ?? [])
    ).map(([x, y]): [number, number] => [x, y]);
    const clock = anchor ? anchor.clock : segment.boot.clock;
    configureSessionTiming(ctx);
    if (clock !== undefined) ctx.clocks.cycle.restore(clock, virtualNow);
    const soundRemainder = anchor ? anchor.soundRemainder : segment.boot.soundRemainder;
    if (soundRemainder !== undefined) ctx.clocks.sound.restore(virtualNow, soundRemainder);
    ctx.cycle.paused = clock?.paused ?? false;
    if (ctx.engine.awaitingKey) ctx.fns.setKeyWaiting(true);

    // The resume point's semantic fingerprint was recorded live; the
    // scratch re-derives it from the restored state and the two must
    // agree before a single event replays — drift the sync digest does
    // not cover (PRNG, strings, motion state, queues, clocks) fails here.
    const fingerprint = anchor !== null ? anchor.fingerprint : segment.boot.fingerprint;
    if (fingerprint.v !== HISTORY_FINGERPRINT_VERSION)
      throw new Error(`resume point carries fingerprint version ${fingerprint.v}`);
    const actual = historyFingerprint(
      captureSemanticState(
        ctx,
        anchor !== null ? historyAnchorSemantic(anchor) : historyBootSemantic(segment.boot),
      ),
    );
    if (actual.hash !== fingerprint.hash)
      throw new Error(
        `${anchor !== null ? `anchor ${anchor.seq}` : "boot"} semantic fingerprint does not hold: the restored state is not the recorded state`,
      );

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
    // Run out the recorded tail: the segment's end tick, the last event, the
    // last sync or room mark — whichever the stream reached last. The view's
    // extent counts room marks too; a drive that stops short of it leaves
    // watch mode rebuilding from the anchor on every advance.
    endTick =
      Math.max(
        segment.end?.tick ?? 0,
        events.length ? events[events.length - 1]!.tick : 0,
        segment.sync.length ? segment.sync[segment.sync.length - 1]!.tick : 0,
        segment.marks.length ? segment.marks[segment.marks.length - 1]!.tick : 0,
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
      case "click":
        ctx.fns.onClick({ type: "click", x: cause.x, y: cause.y });
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
      case "clock":
        // Between-poll sound discharges ride the event stream so a cause
        // that observed their effect replays after them.
        for (let i = 0; i < cause.ticks; i++) ctx.fns.recordedClock();
        return;
      case "device": {
        const device = cause.device === 0 ? 0 : 1;
        if (device !== ctx.boot.selectedSoundDevice) engine!.stopSound();
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
      case "projectImage": {
        ctx.boot.project = { documents: cause.documents, documentId: cause.documentId };
        const files = new Map(
          Object.entries(cause.files).map(([name, data]) => [name, base64ToBytes(data)]),
        );
        const result = engine!.commitPreviewUpdate(engine!.preparePreviewUpdate({ files }));
        if (result.status !== "committed" && result.status !== "unchanged")
          throw new Error(`Recorded project image refused: ${result.status}`);
        ctx.boot.currentBootFiles = new Map(engine!.containerFiles);
        const words = files.get("WORDS.TOK");
        if (words !== undefined) {
          ctx.boot.liveDictionary.clear();
          for (const { word, id } of parseWordsTok(words)) ctx.boot.liveDictionary.set(word, id);
          ctx.boot.authoredWords = words;
        }
        return;
      }
      case "patch":
        engine!.patchResources([
          { kind: cause.resource, num: cause.num, payload: base64ToBytes(cause.data) },
        ]);
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
            // A declined room carries prepared:false and no patch — replay
            // must deliver the refusal, not recompile the empty response.
            cause.patch ?? (cause.prepared === false ? null : undefined),
          );
        else
          ctx.fns.onHostAnswer({
            type: "hostAnswer",
            id: cause.request,
            response: cause.response,
          });
        return;
      case "authoring":
        return; // host-side session state — the take path reads it, the engine never does
      case "reseed":
        // Positional only: the drive collected the lane at open and the
        // scratch RNG drains it inside the pass that draws at zero-state.
        return;
      case "restart":
      case "end":
        return; // reproduced by the tick stream / the segment boundary itself
    }
  }

  /**
   * The recorded clock observation for one tick: the sound ticks the live
   * scheduler discharged on that poll and whether its cycle poll fired.
   * The lane is RLE on the tick axis; a tape recorded before the lane
   * existed — or a coverage gap where a batch was torn — falls back to the
   * virtual 60 Hz derivation, which is what the nominal tape recorded.
   */
  let clockRunIdx = 0;
  function clockObs(tick: number): { sound: number; cycle: boolean } | null {
    const runs = segment.clock;
    if (runs === undefined) return null;
    while (clockRunIdx < runs.length && runs[clockRunIdx]!.tick + runs[clockRunIdx]!.n <= tick)
      clockRunIdx++;
    const run = runs[clockRunIdx];
    if (run === undefined || tick < run.tick) return null;
    return run;
  }

  /**
   * One virtual host poll — the shared replayTick fed the recorded clock
   * observation: the sound ticks the live scheduler discharged on that
   * poll (a paused stretch backlogs and bursts inside a single recorded
   * tick, exactly as live) and whether its cycle poll fired. The wall
   * clock is a recorded input, never re-derived.
   */
  function advanceTick(): void {
    replayTick(ctx, clockObs(replay!.tick + 1) ?? undefined);
    virtualNow = (replay!.tick * 1000) / 60;
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
          `recorded event unreachable: replay cannot advance past tick ${replay.tick}: the engine terminated`,
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
