import { reactive } from "vue";

/**
 * The one transport controller. The bar under the screen is a single
 * control; what changes is its source — a walkthrough artifact or the live
 * session's recording. The source supplies the position, marks and verbs;
 * `useTransport` owns the shared interaction machinery: percent math, mark
 * proximity hover and drag-scrub seek scheduling. Mode extras (the tape's
 * resume cluster, the walkthrough's story-pause toggle) arrive through the
 * extras object the domain builds.
 */

/** A notch on the timeline — a checkpoint on an artifact, a mark on the tape. */
export interface TransportMark {
  key: string | number;
  /** Lane position, 0–100. */
  percent: number;
  label: string;
  details?: string;
  /** Marker variant: checkpoint | room | restart | remix | prompt | bookmark. */
  kind?: string;
  testid?: string;
  /** The domain object the mark was built from; handed back on click. */
  payload?: unknown;
}

/** An extra control the source's mode adds to the bar. */
export interface TransportButton {
  testid: string;
  title?: string;
  aria?: string;
  label?: string;
  icon?: "bookmark";
  variant?: "primary" | "secondary";
  disabled?: boolean;
  run(): void;
}

/**
 * What a recording supplies to the transport: where the tape is, where its
 * marks sit, and the verbs a scrub or keypress dispatches. The walkthrough
 * source maps onto the runner's state; the history source maps onto the
 * recording under view.
 */
export interface TransportSource {
  readonly tick: number;
  readonly totalTicks: number;
  readonly seeking: boolean;
  readonly playing: boolean;
  readonly speed: number;
  readonly marks: readonly TransportMark[];
  /** Jump the position — reopening an anchor when the target fell behind. */
  seekTick(tick: number): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setScrubbing(active: boolean): void;
  /** Arrow-key step — a mark hop on the tape, a fixed nudge on an artifact. */
  step(dir: 1 | -1): void;
  /** A marker's own seek; the source knows where its marks land. */
  clickMark(mark: TransportMark): void;
}

/** The mode-specific face of the bar: identity, controls, status rows. */
export interface TransportExtras {
  /** The bar renders at all (the tape still shows pending/error rows). */
  readonly visible: boolean;
  /** The transport strip renders — false leaves only status rows. */
  readonly controls: boolean;
  readonly loadingText: string | undefined;
  readonly testid: string;
  readonly timelineTestid: string;
  readonly timelineLabel: string;
  /** Fill/thumb testids and the marker class, e.g. "walkthrough-marker". */
  readonly fillTestid: string;
  readonly thumbTestid: string;
  readonly markerClass: string;
  /** Source-scoped class on the hover tooltip, e.g. "walkthrough-tooltip". */
  readonly tooltipClass: string;
  readonly play: {
    testid: string;
    icon: "play" | "pause" | "replay";
    title: string;
    aria: string;
    /** A labeled primary action (e.g. "Resume from here") beside the icon. */
    label?: string;
    disabled: boolean;
    /** The primary control's action — the source's agreed meaning per state. */
    run(): void;
  };
  /**
   * The speed group renders. Walkthroughs always show it; the tape shows it
   * only inside the explicit Watch action.
   */
  readonly speedGroup: boolean;
  /**
   * The timeline's right-hand endpoint: the parked live session. `here` is
   * true while the surface already IS live (running or parked at LIVE).
   */
  readonly live: { testid: string; here: boolean; run(): void } | undefined;
  /** Speed-group testid prefix, e.g. "walkthrough-speed-" → `…-4`. */
  readonly speedTestid: string;
  /** Source-scoped class on the active speed/story-pause button. */
  readonly speedActiveClass: string;
  readonly speedTitle: (speed: number) => string;
  /** Position readout, e.g. "Room 4 · 62% · replaying…". */
  readonly readout: string | undefined;
  readonly posTestid: string | undefined;
  /** >0 shows the "earlier tape dropped" note. */
  readonly dropped: number;
  /** Buttons after the speed group (bookmark, resume cluster). */
  readonly trailing: readonly TransportButton[];
  readonly storyPause: { testid: string; on: boolean; toggle(): void } | undefined;
  /** A quiet status row for unsettled recovery work — never a player vote. */
  readonly pending:
    { testid: string; text: string; buttons: readonly TransportButton[] } | undefined;
  /** Status rows; `details` keeps technical diagnostics collapsed. */
  readonly errors: readonly { testid: string; text: string; details?: string }[];
}

/** Everything TransportBar binds: the source, the extras, and the shared
 *  scrub/hover state the controller owns. */
export type TransportModel = TransportSource &
  TransportExtras & {
    readonly percent: number;
    readonly timelineEnabled: boolean;
    readonly isScrubbing: boolean;
    readonly scrubPercent: number | undefined;
    readonly hover: { percent: number; label: string; details?: string } | undefined;
    scrubDown(pct: number): void;
    scrubMove(pct: number): void;
    scrubUp(pct: number): void;
    hoverMove(pct: number): void;
    hoverEnd(): void;
    stepKey(dir: 1 | -1): void;
    markClick(mark: TransportMark): void;
    dispose(): void;
  };

/**
 * Seeks are heavier than a live tick: a forward drag keeps the drive
 * incremental while a backward drag reopens an anchor, so the backward
 * settle is the longer one.
 */
const SCRUB_FORWARD_MS = 150;
const SCRUB_BACKWARD_MS = 350;
/** A mark grabs the hover when the pointer sits within this lane percent. */
const MARK_SNAP_PERCENT = 4;

export function useTransport(source: TransportSource, extras: TransportExtras): TransportModel {
  const ui = reactive({
    isScrubbing: false,
    scrubPercent: undefined as number | undefined,
    hover: undefined as { percent: number; label: string; details?: string } | undefined,
  });
  let hasDragged = false;
  let scrubTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTick: number | null = null;

  function percent(): number {
    return source.totalTicks > 0 ? (source.tick / source.totalTicks) * 100 : 0;
  }

  function tickAt(pct: number): number {
    return Math.round((pct / 100) * source.totalTicks);
  }

  function markNear(pct: number): TransportMark | null {
    let best: TransportMark | null = null;
    let bestDiff = Infinity;
    for (const m of source.marks) {
      const diff = Math.abs(m.percent - pct);
      if (diff < bestDiff && diff < MARK_SNAP_PERCENT) {
        bestDiff = diff;
        best = m;
      }
    }
    return best;
  }

  function showHover(pct: number): void {
    if (source.totalTicks <= 0) return;
    const mark = markNear(pct);
    if (mark) {
      const info: { percent: number; label: string; details?: string } = {
        percent: mark.percent,
        label: mark.label,
      };
      if (mark.details !== undefined) info.details = mark.details;
      ui.hover = info;
    } else {
      ui.hover = { percent: pct, label: `${Math.round(pct)}%` };
    }
  }

  function cancelPendingSeek(): void {
    if (scrubTimer !== null) {
      clearTimeout(scrubTimer);
      scrubTimer = null;
    }
    pendingTick = null;
  }

  function scheduleSeek(tick: number): void {
    pendingTick = tick;
    if (scrubTimer !== null) return;
    const delay = tick < source.tick ? SCRUB_BACKWARD_MS : SCRUB_FORWARD_MS;
    scrubTimer = setTimeout(() => {
      scrubTimer = null;
      if (pendingTick !== null) {
        const target = pendingTick;
        pendingTick = null;
        source.seekTick(target);
      }
    }, delay);
  }

  function scrubDown(pct: number): void {
    // An empty axis still dispatches: the click pauses live play and the
    // source reports whether a tape exists to open or refuses an unreadable
    // one — swallowing the gesture would hide exactly those answers.
    if (source.seeking) return;
    hasDragged = false;
    ui.isScrubbing = true;
    source.setScrubbing(true);
    cancelPendingSeek();
    // Markers are visual-only: dense checkpoint clusters overlap beyond DOM
    // hit-testing's reach, so the pointer resolves the nearest mark itself —
    // the same mark the hover tooltip already named.
    const mark = markNear(pct);
    ui.scrubPercent = mark ? mark.percent : pct;
    showHover(pct);
    if (mark) source.clickMark(mark);
    else source.seekTick(tickAt(pct));
  }

  function scrubMove(pct: number): void {
    if (!ui.isScrubbing) return;
    hasDragged = true;
    ui.scrubPercent = pct;
    showHover(pct);
    scheduleSeek(tickAt(pct));
  }

  function scrubUp(pct: number): void {
    cancelPendingSeek();
    if (!ui.isScrubbing) return;
    const finalPct = ui.scrubPercent ?? pct;
    ui.isScrubbing = false;
    // Resolve the final target while the source still owns its frozen axis.
    if (hasDragged) source.seekTick(tickAt(finalPct));
    source.setScrubbing(false);
    ui.scrubPercent = undefined;
  }

  function hoverMove(pct: number): void {
    if (!ui.isScrubbing) showHover(pct);
  }

  function hoverEnd(): void {
    if (!ui.isScrubbing) ui.hover = undefined;
  }

  function markClick(mark: TransportMark): void {
    if (hasDragged) return;
    ui.hover = undefined;
    source.clickMark(mark);
  }

  function dispose(): void {
    cancelPendingSeek();
  }

  return {
    get tick() {
      return source.tick;
    },
    get totalTicks() {
      return source.totalTicks;
    },
    get seeking() {
      return source.seeking;
    },
    get playing() {
      return source.playing;
    },
    get speed() {
      return source.speed;
    },
    get marks() {
      return source.marks;
    },
    seekTick: (tick) => source.seekTick(tick),
    togglePlay: () => source.togglePlay(),
    setSpeed: (speed) => source.setSpeed(speed),
    setScrubbing: (active) => source.setScrubbing(active),
    step: (dir) => source.step(dir),
    clickMark: (mark) => source.clickMark(mark),
    get visible() {
      return extras.visible;
    },
    get controls() {
      return extras.controls;
    },
    get loadingText() {
      return extras.loadingText;
    },
    get testid() {
      return extras.testid;
    },
    get timelineTestid() {
      return extras.timelineTestid;
    },
    get timelineLabel() {
      return extras.timelineLabel;
    },
    get fillTestid() {
      return extras.fillTestid;
    },
    get thumbTestid() {
      return extras.thumbTestid;
    },
    get markerClass() {
      return extras.markerClass;
    },
    get speedActiveClass() {
      return extras.speedActiveClass;
    },
    get tooltipClass() {
      return extras.tooltipClass;
    },
    get play() {
      return extras.play;
    },
    get speedGroup() {
      return extras.speedGroup;
    },
    get live() {
      return extras.live;
    },
    get speedTestid() {
      return extras.speedTestid;
    },
    get speedTitle() {
      return extras.speedTitle;
    },
    get readout() {
      return extras.readout;
    },
    get posTestid() {
      return extras.posTestid;
    },
    get dropped() {
      return extras.dropped;
    },
    get trailing() {
      return extras.trailing;
    },
    get storyPause() {
      return extras.storyPause;
    },
    get pending() {
      return extras.pending;
    },
    get errors() {
      return extras.errors;
    },
    get percent() {
      return percent();
    },
    get timelineEnabled() {
      return source.totalTicks > 0 && !source.seeking;
    },
    get isScrubbing() {
      return ui.isScrubbing;
    },
    get scrubPercent() {
      return ui.scrubPercent;
    },
    get hover() {
      return ui.hover;
    },
    scrubDown,
    scrubMove,
    scrubUp,
    hoverMove,
    hoverEnd,
    stepKey: (dir) => source.step(dir),
    markClick,
    dispose,
  };
}
