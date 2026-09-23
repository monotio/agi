/**
 * History viewing: while the live session stays parked behind its
 * acknowledged pause, a scratch session on the side replays the recorded
 * stream through a real Engine and posts its frames to the real surface.
 * The scratch runs on the history drive (worker/replay.ts): recorded
 * answers resolve its host requests, its own control traffic is swallowed,
 * and its sound stays silent. It writes nothing — no autosave, no journal
 * notices, no recorded batches, no provider calls.
 *
 * Resume here / Back to before: taking a viewed moment captures the
 * scratch's full resume point and adopts it as the live session under a new
 * segment whose boot records where it branched from; restoring a retained
 * original is the same adoption with a stored boot record. The departing
 * session's segment ends with reason "resume" — the tape is never
 * rewritten, only continued.
 */
import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import { base64ToBytes, bytesToBase64 } from "../bytes.ts";
import {
  HISTORY_FINGERPRINT_VERSION,
  historyBootSemantic,
  historyFingerprint,
  stampBoot,
  validateHistoryBoot,
  type HistoryBoot,
  type HistorySegment,
} from "../../../src/agent/history.ts";
import { resourceSetHint } from "../../../src/agent/authoringState.ts";
import { openHistoryDrive, type HistoryDrive } from "./replay.ts";
import type { Inbound, WorkerContext } from "./context.ts";

const V_ROOM = 0;
const V_SCORE = 3;

/** Wall-clock budget per drive chunk so a long seek never starves the worker. */
const CHUNK_BUDGET_MS = 12;

export function createHistoryView(ctx: WorkerContext) {
  /**
   * Whether the view session has successfully opened: a start whose landing
   * report carried an error leaves no half-open session — the recording and
   * drive are dropped so later view traffic gets a clean refusal, and the
   * live surface was never repainted over by scratch frames.
   */
  let opened = false;

  /** Current position plus what the transport needs to gate Resume here. */
  function position() {
    const drive = ctx.view.drive;
    const engine = drive?.ctx.engine ?? null;
    return {
      generation: ctx.view.generation,
      tick: drive?.tick ?? 0,
      seq: drive?.seq ?? 0,
      cycle: drive?.ctx.cycle.cycleCount ?? 0,
      room: engine ? (engine.vars[V_ROOM] ?? 0) : 0,
      score: engine ? (engine.vars[V_SCORE] ?? 0) : 0,
      modal: engine?.modalKind ?? null,
      canResume:
        drive !== null &&
        engine !== null &&
        drive.diverged === null &&
        drive.error === null &&
        engine.recordingImage() !== null,
      diverged: drive?.diverged ?? null,
      error: drive?.error ?? null,
    };
  }

  function postReport(id: number, final: boolean, superseded = false): void {
    ctx.ports.control({
      type: "historyView",
      id,
      final,
      ...(superseded ? { superseded: true } : {}),
      segment: ctx.view.segment,
      ...position(),
    });
  }

  function postViewError(id: number, error: string): void {
    ctx.ports.control({
      type: "historyView",
      id,
      final: true,
      generation: ctx.view.generation,
      segment: ctx.view.segment,
      tick: ctx.view.drive?.tick ?? 0,
      seq: ctx.view.drive?.seq ?? 0,
      cycle: 0,
      room: 0,
      score: 0,
      modal: null,
      canResume: false,
      diverged: null,
      error,
    });
  }

  /**
   * The request a newer one replaced still settles — its host-side query
   * resolves with superseded:true rather than leaking until timeout.
   */
  function settleRequest(): void {
    const view = ctx.view;
    if (view.timer !== null) {
      clearTimeout(view.timer);
      view.timer = null;
    }
    if (view.request !== null) {
      const id = view.request;
      view.request = null;
      postReport(id, true, true);
    }
  }

  /** Open the scratch drive on a segment: nearest anchor at-or-before the target. */
  function openDrive(segment: HistorySegment, tick: number): HistoryDrive {
    let anchorIdx: number | undefined;
    for (let i = segment.anchors.length - 1; i >= 0; i--) {
      if (segment.anchors[i]!.tick <= tick) {
        anchorIdx = i;
        break;
      }
    }
    const drive = openHistoryDrive(segment, {
      ...(anchorIdx !== undefined ? { anchor: anchorIdx } : {}),
      ports: {
        // Scratch host requests resolve from the recorded answers, never the
        // host; only a real engine fault surfaces.
        control: (message) => {
          if (message.type === "error") ctx.ports.control(message);
        },
        // Frames flow to the real surface; sound and mirrors stay in the scratch.
        presentation: (message, transfer) => {
          if (message.type === "frame") ctx.ports.presentation(message, transfer);
        },
      },
    });
    return drive;
  }

  /**
   * Step the current drive toward `target` in wall-clock chunks. A seek
   * suppresses scratch frames until it lands; a watch (advance) republishes
   * each chunk so the recording visibly unfolds. The terminal report goes
   * out only while this is still the current request.
   */
  function pump(requestId: number, target: number, watch: boolean): void {
    const view = ctx.view;
    const drive = view.drive;
    if (drive === null || view.request !== requestId) return; // superseded or closed
    const scratch = drive.ctx;
    // The seek gates both contexts: the live flag drops scratch frames in
    // transit, and the scratch's own flag makes its postFrame return before
    // the sameness cache sees them — otherwise a dropped mid-seek frame
    // would count as published and the terminal frame could judge itself
    // "same" and never post, leaving the screen one position behind.
    ctx.replay.isSeeking = !watch;
    scratch.replay.isSeeking = !watch;
    try {
      const start = ctx.ports.now();
      while (!drive.halted && (drive.tick < target || drive.nextEventTick <= target)) {
        drive.step();
        if (ctx.ports.now() - start > CHUNK_BUDGET_MS) {
          if (watch) scratch.fns.postFrame();
          postReport(requestId, false);
          view.timer = setTimeout(() => {
            view.timer = null;
            pump(requestId, target, watch);
          }, 0);
          return;
        }
      }
    } catch (error) {
      // A thrown boundary must not leave the frame gate latched: report the
      // failure as the request's terminal answer and release both flags.
      view.request = null;
      ctx.replay.isSeeking = false;
      scratch.replay.isSeeking = false;
      postViewError(requestId, String(error));
      if (!opened) endView(false);
      return;
    }
    view.request = null;
    ctx.replay.isSeeking = false;
    scratch.replay.isSeeking = false;
    scratch.fns.postFrame();
    postReport(requestId, true);
    // A start that could not open the tape leaves no half-open session.
    if (!opened) {
      if (drive.error !== null) endView(false);
      else opened = true;
    }
  }

  /**
   * Serve a seek: reuse the drive when the target is ahead on the same
   * segment, otherwise reopen at the nearest anchor at-or-before it — a
   * backward scrub or a diverged drive both rebuild.
   */
  function beginSeek(requestId: number, segmentIdx: number, tick: number, watch: boolean): void {
    settleRequest();
    const view = ctx.view;
    const segment = view.recording?.segments[segmentIdx];
    if (segment === undefined) {
      postViewError(requestId, `no segment ${segmentIdx} in the recording`);
      if (!opened) endView(false); // a start that cannot serve leaves no session
      return;
    }
    let drive = view.drive;
    if (view.segment !== segmentIdx || drive === null || drive.halted || drive.tick > tick) {
      drive = openDrive(segment, tick);
      view.drive = drive;
      view.segment = segmentIdx;
    }
    view.request = requestId;
    pump(requestId, tick, watch);
  }

  function onHistoryViewStart(msg: Inbound<"historyViewStart">): void {
    endView(false);
    ctx.view.generation++;
    ctx.view.recording = msg.recording;
    ctx.view.segment = msg.segment;
    ctx.view.drive = null;
    beginSeek(msg.id, msg.segment, msg.tick, false);
  }

  function onHistoryViewSeek(msg: Inbound<"historyViewSeek">): void {
    if (ctx.view.recording === null) {
      postViewError(msg.id, "no history view session is open");
      return;
    }
    beginSeek(msg.id, msg.segment, msg.tick, false);
  }

  function onHistoryViewAdvance(msg: Inbound<"historyViewAdvance">): void {
    const view = ctx.view;
    if (view.recording === null || view.drive === null) {
      postViewError(msg.id, "no history view session is open");
      return;
    }
    beginSeek(
      msg.id,
      view.segment,
      Math.min(view.drive.tick + msg.ticks, view.drive.endTick),
      true,
    );
  }

  /** Drop the scratch session; repaint asks the live engine to reclaim the surface. */
  function endView(repaint: boolean): void {
    settleRequest();
    opened = false;
    ctx.replay.isSeeking = false;
    ctx.view.drive = null;
    ctx.view.recording = null;
    if (repaint && ctx.engine) {
      // The displayed frame is a viewed one; the sameness cache would call
      // an identical live frame a no-op, so invalidate before reposting.
      ctx.presentation.lastVisual = null;
      ctx.presentation.lastText = null;
      ctx.presentation.lastModal = null;
      ctx.presentation.lastInputEdit = "";
      ctx.fns.postFrame();
    }
  }

  function onHistoryViewEnd(): void {
    endView(true);
  }

  /** The parked live session's resume point for the retained-original slot. */
  function onHistoryRetain(msg: Inbound<"historyRetain">): void {
    const h = ctx.history;
    ctx.ports.control({
      type: "historyRetained",
      id: msg.id,
      boot: ctx.fns.historySnapshot(),
      from:
        h.segment === null
          ? null
          : { segment: h.segment, seq: h.seq, tick: ctx.cycle.tickCount - h.tickBase },
    });
  }

  /**
   * Adopt a boot record as the live session: end the departing segment,
   * rebuild the live engine on the record's container and image, hand it the
   * recorded queues and serials, then open the next segment — its boot's
   * resumedFrom points back at the position this session continued from.
   */
  function adoptBoot(
    boot: HistoryBoot,
    from: { segment: string; seq: number; tick: number } | null,
  ): void {
    const files = new Map(
      Object.entries(boot.files).map(([name, data]) => [name, base64ToBytes(data)]),
    );
    const dictionary = new Map(boot.dictionary);
    // Build and verify the incoming session before any live mutation: a boot
    // whose recorded state does not reproduce after restore is refused with
    // the departing session untouched. The image's recorded presentation is
    // restored verbatim — the live-restore redraw would rewrite the text
    // ages the snapshot carries.
    const candidate = new Engine(
      openContainer(files),
      ctx.host,
      dictionary,
      boot.profile ? { profile: boot.profile } : undefined,
    );
    if (boot.image !== undefined)
      candidate.restoreImage(base64ToBytes(boot.image), { preservePresentation: true });
    if (boot.menus !== undefined) candidate.restoreMenuState(boot.menus);
    if (boot.replay !== undefined) candidate.restoreReplayState(boot.replay);
    if (boot.fingerprint.v !== HISTORY_FINGERPRINT_VERSION)
      throw new Error(`history boot carries fingerprint version ${boot.fingerprint.v}`);
    const semantic = historyBootSemantic(boot);
    if (semantic.image !== undefined) {
      const image = candidate.recordingImage();
      if (image === null) throw new Error("the adopted state is not a resumable boundary");
      semantic.image = bytesToBase64(image);
    }
    if (semantic.replay !== undefined) semantic.replay = candidate.captureReplayState();
    if (semantic.menus !== undefined) semantic.menus = candidate.readMenuState();
    if (historyFingerprint(semantic).hash !== boot.fingerprint.hash)
      throw new Error("the adopted state is not the recorded state");
    ctx.fns.abandonHostRequest();
    endView(false);
    ctx.fns.historyEnd("resume");
    ctx.boot.liveDictionary = dictionary;
    ctx.boot.currentBootFiles = files;
    ctx.boot.currentDictionary = dictionary;
    ctx.boot.authorRooms = boot.authorRooms;
    ctx.boot.profile = boot.profile ?? null;
    ctx.boot.authoredWords = null;
    ctx.boot.selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
    ctx.hostRequests.hostRequestOutstanding = null;
    ctx.hostRequests.hostRequestSerial = boot.requestSerial;
    ctx.hostRequests.pendingReenter = false;
    ctx.input.keyQueue = [...(boot.inputQueue ?? [])];
    ctx.input.deferredMovement = [...(boot.directionQueue ?? [])];
    ctx.input.inputBuffer = [...(boot.inputLines ?? [])];
    ctx.input.clickQueue = (boot.clickQueue ?? []).map(([x, y]): [number, number] => [x, y]);
    ctx.engine = candidate;
    ctx.fns.armJournal();
    ctx.fns.setKeyWaiting(ctx.engine.awaitingKey);
    ctx.engine.vars[22] = ctx.boot.selectedSoundDevice === 0 ? 1 : 3;
    // The adopted session is live but stays parked: the host's pause owners
    // decide when it runs again (an open map or bubble can outlast the swap).
    // Its host continuation is restored whole: the live PRNG resumes from the
    // recorded state (not the abandoned future's) and the recorded cycle
    // clock is deferred — a parked poll would discard its accumulators, so
    // it lands on the host's first release instead.
    ctx.cycle.pendingClock = boot.clock ?? null;
    if (boot.clock === undefined) ctx.clocks.cycle.reset(ctx.ports.now());
    if (boot.soundRemainder !== undefined)
      ctx.clocks.sound.restore(ctx.ports.now(), boot.soundRemainder);
    else ctx.clocks.sound.reset(ctx.ports.now());
    ctx.cycle.paused = true;
    ctx.ports.control({ type: "paused", paused: true, cycle: ctx.cycle.cycleCount });
    ctx.history.resumedFrom = from;
    ctx.history.rng = boot.rng;
    ctx.fns.rebaselineJournal();
    ctx.fns.historyResume();
    ctx.presentation.lastVisual = null;
    ctx.fns.postFrame();
  }

  /**
   * The viewed moment becomes the live session. The worker enforces the
   * take itself rather than trusting the transport's button state: the
   * message must name the settled position the host confirmed (a stale
   * press after another seek adopts nothing), the drive must have
   * finished its checks (no request in flight), and the tape must have
   * held to this position — a diverged or errored drive shows an
   * unverified state and adopting it would make it live.
   */
  function onHistoryViewTake(msg: Inbound<"historyViewTake">): void {
    const refuse = (message: string): void => {
      ctx.ports.control({ type: "historyTaken", id: msg.id, ok: false, message });
    };
    const view = ctx.view;
    const drive = view.drive;
    const scratch = drive?.ctx;
    const engine = scratch?.engine ?? null;
    const segment = view.recording?.segments[view.segment];
    if (
      msg.generation !== view.generation ||
      drive === null ||
      scratch === undefined ||
      engine === null ||
      segment === undefined
    ) {
      refuse("not viewing");
      return;
    }
    if (view.request !== null) {
      refuse("a seek is still settling");
      return;
    }
    if (msg.segment !== view.segment || msg.tick !== drive.tick || msg.seq !== drive.seq) {
      refuse("the viewed position moved since the take was issued");
      return;
    }
    if (drive.diverged !== null) {
      refuse(`the tape diverged: ${drive.diverged.detail}`);
      return;
    }
    if (drive.error !== null) {
      refuse(drive.error);
      return;
    }
    const image = engine.recordingImage();
    if (image === null) {
      ctx.ports.control({
        type: "historyTaken",
        id: msg.id,
        ok: false,
        message: "the viewed moment is not a resumable boundary",
      });
      return;
    }
    const files = new Map(engine.containerFiles);
    if (scratch.boot.authoredWords) files.set("WORDS.TOK", scratch.boot.authoredWords);
    // The adopted position's semantic fingerprint rides the boot so the
    // segment it opens verifies the same resume point on replay.
    const boot = stampBoot({
      files: Object.fromEntries([...files].map(([name, data]) => [name, bytesToBase64(data)])),
      dictionary: [...scratch.boot.liveDictionary.entries()],
      authorRooms: scratch.boot.authorRooms,
      ...(scratch.boot.profile ? { profile: scratch.boot.profile } : {}),
      image: bytesToBase64(image),
      replay: engine.captureReplayState(),
      menus: engine.readMenuState(),
      inputQueue: [...scratch.input.keyQueue],
      directionQueue: [...scratch.input.deferredMovement],
      inputLines: [...scratch.input.inputBuffer],
      ...(scratch.input.clickQueue.length > 0
        ? { clickQueue: scratch.input.clickQueue.map(([x, y]): [number, number] => [x, y]) }
        : {}),
      clock: scratch.clocks.cycle.snapshot(),
      soundRemainder: scratch.clocks.sound.snapshot(),
      rng: scratch.replay.replay?.random ?? ctx.history.rng,
      soundDevice: scratch.boot.selectedSoundDevice,
      resourceSet: resourceSetHint({ getFiles: () => files }),
      requestSerial: scratch.hostRequests.hostRequestSerial,
    });
    // The authoring state belonging to these bytes: the last checkpoint the
    // host committed at-or-before this position — earlier segments count, a
    // take mid-commit simply sees the previous one. Scanning back, a
    // resource mutation newer than the newest checkpoint means the tape
    // lacks the covering checkpoint (an unbatched post, a truncated
    // stream) — a stale snapshot must never install, so the scan reports
    // none and the host's carry-or-rebuild decides.
    let session: Record<string, unknown> | undefined;
    scan: for (let s = view.segment; s >= 0; s--) {
      const seg = view.recording!.segments[s]!;
      const last = s === view.segment ? drive.seq : Number.MAX_SAFE_INTEGER;
      for (let i = seg.events.length - 1; i >= 0; i--) {
        const event = seg.events[i]!;
        if (event.seq >= last) continue;
        const cause = event.cause;
        if (cause.kind === "authoring") {
          session = cause.snapshot;
          break scan;
        }
        if (
          cause.kind === "patch" ||
          cause.kind === "patchMeta" ||
          (cause.kind === "answer" && cause.prepared === true)
        )
          break scan;
      }
    }
    try {
      adoptBoot(boot, { segment: segment.id, seq: drive.seq, tick: drive.tick });
    } catch (error) {
      refuse(String(error));
      return;
    }
    ctx.ports.control({
      type: "historyTaken",
      id: msg.id,
      ok: true,
      boot,
      ...(session !== undefined ? { session } : {}),
    });
  }

  /** A retained original becomes the live session again. */
  function onHistoryViewRestore(msg: Inbound<"historyViewRestore">): void {
    let boot: HistoryBoot;
    try {
      boot = validateHistoryBoot(msg.boot);
    } catch (error) {
      ctx.ports.control({
        type: "historyViewRestored",
        id: msg.id,
        ok: false,
        message: String(error),
      });
      return;
    }
    try {
      adoptBoot(boot, msg.from);
    } catch (error) {
      ctx.ports.control({
        type: "historyViewRestored",
        id: msg.id,
        ok: false,
        message: String(error),
      });
      return;
    }
    // The ack names the adopted revision so the host can check the record it
    // sent is the state the worker actually took — a mismatch means the
    // stored boot did not survive the trip.
    ctx.ports.control({
      type: "historyViewRestored",
      id: msg.id,
      ok: true,
      resourceSet: boot.resourceSet,
    });
  }

  return {
    onHistoryViewStart,
    onHistoryViewSeek,
    onHistoryViewAdvance,
    onHistoryViewEnd,
    onHistoryViewTake,
    onHistoryRetain,
    onHistoryViewRestore,
  };
}
