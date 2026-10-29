/** Host recording state deliberately excluded from authentic save.game images. */
import type { InputEvent } from "./inputQueue.ts";
import type { WindowFrameGeometry, WindowOverlay, GadgetFill } from "./textSurface.ts";
import type { ViewLoopState } from "../view/view.ts";

/**
 * A modal's covered cells, serialized. `cells` are the row-major [char, attr]
 * pairs of the inclusive rect; `written` its per-cell write stamps — together
 * they restore both the text and its age under screen objects. `window` optionally
 * carries the active window's sub-cell pixel frame metadata so a resumed
 * continuation re-stamps its authentic border.
 */
export interface SerializedSavedRect {
  written: number[];
  top: number;
  left: number;
  bottom: number;
  right: number;
  cells: number[];
  window?: WindowOverlay | undefined;
}

/** A parked modal window; fresh serials are assigned on restore. */
type SerializedModal =
  | { kind: "print"; saved: SerializedSavedRect; remainingMs: number | null; pauseClock: boolean }
  | {
      kind: "inventory";
      saved: SerializedSavedRect;
      items: { num: number; name: string }[];
      slots: { row: number; col: number }[];
      selected: number;
      interactive: boolean;
    }
  | {
      kind: "menu";
      saved: SerializedSavedRect;
      /** The Amiga strip's open title, item and host-held mode; absent for the PC menu. */
      native?: { heading: number | null; item: number | null; sticky: boolean };
    }
  | { kind: "showObj"; saved: SerializedSavedRect; view: number }
  | { kind: "showPri" }
  | { kind: "shake"; steps: number; step: number; elapsedMs: number; palette: number[] | null }
  | {
      kind: "dissolve";
      elapsedMs: number;
      durationMs: number;
      skipRows: boolean;
      /** The screen it started from: 26,880 hex digits, one colour a pixel. */
      from: string;
    };

/**
 * A logic pass parked at a resumable boundary — an open window or a have.key
 * wait — serialized so a checkpoint resumes the identical instruction. Host
 * interactions that hold a live request (prompts, selectors, confirmations,
 * room authoring) never reach this record: their snapshots stay refused.
 */
export interface ParkedContinuation {
  /**
   * The parked call stack, innermost frame last. `hash` is fnv1a32 of the
   * logic resource's bytes, so a continuation only resumes into identical
   * code — a patch to any frame's logic makes it stale regardless of which
   * session captured it.
   */
  frames: { logic: number; pc: number; hash: number }[];
  modals: SerializedModal[];
  persistentWindow: SerializedSavedRect | null;
  /** A have.key parked mid-condition, with its replayable prior outcomes. */
  keyWait: { condPc: number; outcomes: [number, boolean][]; haveKeyPolls: number } | null;
}

export interface PlaybackState {
  device: number;
  active: boolean;
  /** IIgs fade watchdog state; null while disarmed or on other sound families. */
  fade: { pace: number; countdown: number; budget: number } | null;
  channels: {
    cursor: number;
    countdown: number;
    terminated: boolean;
    base: number;
    envelopeIndex: number;
    envelopeValue: number;
  }[];
}
/** Optional native joystick service state; omission is the released disconnected host. */
export interface JoystickReplayState {
  enabled: boolean;
  clockMs: number;
  thresholds: number[];
  direction: number;
  buttons: { state: 0 | 1 | 2 | 3; deadline: number }[];
  calibration: number | null;
  /** init.joy found no pad; the first sample brings it online (optional). */
  pendingInit?: true;
}

export function validateJoystickState(value: unknown): JoystickReplayState {
  const pending =
    value !== null && typeof value === "object" && Object.hasOwn(value, "pendingInit");
  const s = record(value, [
    "enabled",
    "clockMs",
    "thresholds",
    "direction",
    "buttons",
    "calibration",
    ...(pending ? ["pendingInit"] : []),
  ]);
  if (pending && s["pendingInit"] !== true) throw new Error("Replay joystick state is invalid.");
  const thresholds = array(s["thresholds"], 4, (v) => number(v, -65535, 131070, false));
  const buttons = array(s["buttons"], 2, (v) => {
    const b = record(v, ["state", "deadline"]);
    return {
      state: number(b["state"], 0, 3) as 0 | 1 | 2 | 3,
      deadline: number(b["deadline"], 0, Number.MAX_SAFE_INTEGER, false),
    };
  });
  if (
    thresholds.length !== 4 ||
    buttons.length !== 2 ||
    thresholds[0]! > thresholds[1]! ||
    thresholds[2]! > thresholds[3]!
  )
    throw new Error("Replay joystick state is inconsistent.");
  return {
    enabled: bool(s["enabled"]),
    clockMs: number(s["clockMs"], 0, Number.MAX_SAFE_INTEGER, false),
    thresholds,
    direction: number(s["direction"], 0, 8),
    buttons,
    calibration: s["calibration"] === null ? null : number(s["calibration"], 0, 63),
    ...(pending ? { pendingInit: true as const } : {}),
  };
}

/** Version 1 (released without a stamp) used zero-separated booter row cursors. */
export const REPLAY_STATE_VERSION = 2;

export interface EngineReplayState {
  /** Omitted for released/unchanged semantics; version 2 marks corrected booter playback. */
  version?: 1 | typeof REPLAY_STATE_VERSION;
  joystick?: JoystickReplayState;
  amigaRegion?: "ntsc" | "pal";
  /** The PC display the recorded session ran on (src/runtime/display.ts); absent is EGA. */
  pcDisplay?: "cga-rgb";
  /** The PC monitor type after toggle.monitor changed it (src/runtime/display.ts). */
  monitorType?: number;
  /** Present once set.pri.base has replaced the default priority table (PriToY). */
  priorityTableRebuilt?: true;
  /** 2.001 ticks since the last clock refresh, when nonzero. */
  booterClockPhase?: number;
  /**
   * Amiga/IIgs: overlay.pic set the show.pic mode flag, so the next show.pic
   * copies at once (docs/fidelity.md "Original picture dissolve"). Older
   * states omit it and keep what the image's picture replay left.
   */
  pictureRevealInstant?: boolean;
  clockRemainderMs: number;
  pictureShown: boolean;
  terminated: boolean;
  statusRefreshRequested: boolean;
  priorityBase: number;
  key: number;
  egoHidden: number;
  inputReady: number;
  saidMatched: number;
  controllers: number[];
  parsedWords: number[];
  parsedWordTexts: string[];
  parserCount: number;
  lastInputLine: string;
  editLine: string;
  acceptedLine: string;
  inputWidthCap: number | null;
  pendingController: number | null;
  inputQueue: InputEvent[];
  menu: {
    title: string;
    enabled: boolean;
    current: number;
    items: { text: string; id: number; enabled: boolean }[];
  }[];
  menuFinalized: boolean;
  menuHeading: number;
  menuRequested: boolean;
  /** Host input gates; omitted recordings keep the values left by restoreImage. */
  menuGate?: number;
  releaseGate?: number;
  objectExtras: { priority: number }[];
  /**
   * Exact decoded-view residency and allocation order at a harness boundary.
   * `loops` carries each loaded packed view's loop orientation by view
   * number (packed 2.230 only; docs/fidelity.md F-VIEWS-01). Absent in
   * recordings made before 1.2.6: the restore rebinds each object's loop
   * instead, which reproduces a single alias but not a longer selection
   * history.
   */
  viewCache: { loaded: number[]; order: number[]; loops?: Record<string, ViewLoopState[]> };
  gameSignature: string;
  sound: { num: number; doneFlag: number; playback: PlaybackState } | null;
  /** Live-patch counter — harness session state, not save-file state. */
  patchGeneration: number;
  /** The parked pass, when the snapshot was taken at a resumable boundary. */
  continuation: ParkedContinuation | null;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Replay state requires an object.");
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(obj, field))
  )
    throw new Error("Replay state has missing or unknown fields.");
  return obj;
}
function number(value: unknown, min: number, max: number, integral = true): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integral && !Number.isInteger(value))
  )
    throw new Error("Replay state number is out of range.");
  return value;
}
function nullable(value: unknown, max = 255): number | null {
  return value === null ? null : number(value, 0, max);
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Replay state requires boolean.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000)
    throw new Error("Replay state text is invalid.");
  return value;
}
function array<T>(value: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Replay state array is too long.");
  return value.map(parse);
}
function gadgetFill(value: unknown): GadgetFill {
  const g = record(value, ["x0", "y0", "x1", "y1", "pen", "label"]);
  const label = record(g["label"], ["x0", "y0", "x1", "y1"]);
  const px = (v: unknown): number => number(v, -8192, 8192);
  return {
    x0: px(g["x0"]),
    y0: px(g["y0"]),
    x1: px(g["x1"]),
    y1: px(g["y1"]),
    pen: number(g["pen"], 0, 15),
    label: { x0: px(label["x0"]), y0: px(label["y0"]), x1: px(label["x1"]), y1: px(label["y1"]) },
  };
}
function savedRect(value: unknown, options?: { allowWindow?: boolean }): SerializedSavedRect {
  const hasWindow = value !== null && typeof value === "object" && Object.hasOwn(value, "window");
  const s = record(
    value,
    hasWindow
      ? ["written", "top", "left", "bottom", "right", "cells", "window"]
      : ["written", "top", "left", "bottom", "right", "cells"],
  );
  const top = number(s["top"], 0, 24);
  const left = number(s["left"], 0, 39);
  const bottom = number(s["bottom"], 0, 24);
  const right = number(s["right"], 0, 39);
  const w = right - left + 1;
  const h = bottom - top + 1;
  const cells = array(s["cells"], 25 * 40 * 2, (v) => number(v, 0, 255));
  const written = array(s["written"], 25 * 40, (v) => number(v, 0, 4294967295));
  if (cells.length !== w * h * 2 || written.length !== w * h)
    throw new Error("Replay state saved rect dimensions are invalid.");
  let window: WindowOverlay | undefined;
  if (hasWindow && s["window"] !== undefined) {
    if (options?.allowWindow === false)
      throw new Error(
        "Replay state saved.window requires recording version 3 or host image version 2.",
      );
    const hasErased =
      s["window"] !== null &&
      typeof s["window"] === "object" &&
      Object.hasOwn(s["window"], "erased");
    const hasGadgets =
      s["window"] !== null &&
      typeof s["window"] === "object" &&
      Object.hasOwn(s["window"], "gadgets");
    const win = record(s["window"], [
      "geometry",
      "textTop",
      "textLeft",
      "textRows",
      "textCols",
      "x0",
      "y0",
      "x1",
      "y1",
      "seq",
      ...(hasErased ? ["erased"] : []),
      ...(hasGadgets ? ["gadgets"] : []),
    ]);
    const geometry = win["geometry"];
    if (geometry !== "pc-2.001" && geometry !== "pc" && geometry !== "amiga" && geometry !== "iigs")
      throw new Error("Replay state window geometry is invalid.");
    const erased =
      hasErased && win["erased"] !== undefined
        ? array(win["erased"], 320 * 200, (v) => number(v, 0, 320 * 200 - 1))
        : undefined;
    window = {
      geometry: geometry as WindowFrameGeometry,
      textTop: number(win["textTop"], -1024, 1024),
      textLeft: number(win["textLeft"], -1024, 1024),
      textRows: number(win["textRows"], 0, 256),
      textCols: number(win["textCols"], 0, 256),
      x0: number(win["x0"], -8192, 8192),
      y0: number(win["y0"], -8192, 8192),
      x1: number(win["x1"], -8192, 8192),
      y1: number(win["y1"], -8192, 8192),
      seq: number(win["seq"], 0, 0xffffffff),
      ...(erased !== undefined ? { erased } : {}),
      ...(win["gadgets"] !== undefined ? { gadgets: array(win["gadgets"], 8, gadgetFill) } : {}),
    };
  }
  return {
    written,
    top,
    left,
    bottom,
    right,
    cells,
    ...(window !== undefined ? { window } : {}),
  };
}

function serializedModal(value: unknown, options?: { allowWindow?: boolean }): SerializedModal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Replay state requires an object.");
  const kind = (value as Record<string, unknown>)["kind"];
  switch (kind) {
    case "print": {
      const m = record(value, ["kind", "saved", "remainingMs", "pauseClock"]);
      return {
        kind,
        saved: savedRect(m["saved"], options),
        pauseClock: bool(m["pauseClock"]),
        remainingMs:
          m["remainingMs"] === null ? null : number(m["remainingMs"], 0, 0xffffffff, false),
      };
    }
    case "inventory": {
      const m = record(value, ["kind", "saved", "items", "slots", "selected", "interactive"]);
      return {
        kind,
        saved: savedRect(m["saved"], options),
        items: array(m["items"], 255, (v) => {
          const item = record(v, ["num", "name"]);
          return { num: number(item["num"], 0, 255), name: text(item["name"]) };
        }),
        slots: array(m["slots"], 255, (v) => {
          const slot = record(v, ["row", "col"]);
          return { row: number(slot["row"], 0, 24), col: number(slot["col"], 0, 39) };
        }),
        selected: number(m["selected"], 0, 255),
        interactive: bool(m["interactive"]),
      };
    }
    case "menu": {
      const hasNative = Object.hasOwn(value, "native");
      const m = record(value, hasNative ? ["kind", "saved", "native"] : ["kind", "saved"]);
      if (!hasNative) return { kind, saved: savedRect(m["saved"], options) };
      const n = record(m["native"], ["heading", "item", "sticky"]);
      return {
        kind,
        saved: savedRect(m["saved"], options),
        native: {
          heading: nullable(n["heading"]),
          item: nullable(n["item"]),
          sticky: bool(n["sticky"]),
        },
      };
    }
    case "showObj": {
      const m = record(value, ["kind", "saved", "view"]);
      return { kind, saved: savedRect(m["saved"], options), view: number(m["view"], 0, 255) };
    }
    case "showPri":
      record(value, ["kind"]);
      return { kind };
    case "shake": {
      const m = record(value, ["kind", "steps", "step", "elapsedMs", "palette"]);
      const steps = number(m["steps"], 1, 255 * 8);
      const step = number(m["step"], 0, steps - 1);
      const palette =
        m["palette"] === null ? null : array(m["palette"], 16, (v) => number(v, 0, 0xfff));
      if (palette !== null && palette.length !== 16)
        throw new Error("Replay shake palette needs sixteen colours.");
      return {
        kind,
        steps,
        step,
        elapsedMs: number(m["elapsedMs"], 0, 1000, false),
        palette,
      };
    }
    case "dissolve": {
      const m = record(value, ["kind", "elapsedMs", "durationMs", "skipRows", "from"]);
      const durationMs = number(m["durationMs"], 1, 2000, false);
      if (typeof m["from"] !== "string" || !/^[0-9a-f]{26880}$/.test(m["from"]))
        throw new Error("Replay dissolve frame is invalid.");
      return {
        kind,
        elapsedMs: number(m["elapsedMs"], 0, durationMs, false),
        durationMs,
        skipRows: bool(m["skipRows"]),
        from: m["from"],
      };
    }
    default:
      throw new Error("Replay state has an unknown modal kind.");
  }
}

/** Validate a serialized parked pass, or null for a non-parked snapshot. */
export function validateContinuation(
  value: unknown,
  options?: { allowWindow?: boolean },
): ParkedContinuation | null {
  if (value === null) return null;
  const s = record(value, ["frames", "modals", "persistentWindow", "keyWait"]);
  let keyWait: ParkedContinuation["keyWait"] = null;
  if (s["keyWait"] !== null) {
    const k = record(s["keyWait"], ["condPc", "outcomes", "haveKeyPolls"]);
    keyWait = {
      condPc: number(k["condPc"], 0, 65535),
      outcomes: array(k["outcomes"], 256, (v) => {
        if (!Array.isArray(v) || v.length !== 2)
          throw new Error("Replay state outcome pair is invalid.");
        return [number(v[0], 0, 65535), bool(v[1])];
      }),
      haveKeyPolls: number(k["haveKeyPolls"], 0, 0xffffffff),
    };
  }
  return {
    frames: array(s["frames"], 256, (v) => {
      const f = record(v, ["logic", "pc", "hash"]);
      return {
        logic: number(f["logic"], 0, 255),
        pc: number(f["pc"], 0, 65535),
        hash: number(f["hash"], 0, 0xffffffff),
      };
    }),
    modals: array(s["modals"], 8, (v) => serializedModal(v, options)),
    persistentWindow:
      s["persistentWindow"] === null ? null : savedRect(s["persistentWindow"], options),
    keyWait,
  };
}

export function validatePlaybackState(value: unknown): PlaybackState {
  const s = record(value, ["device", "active", "fade", "channels"]);
  let fade: PlaybackState["fade"] = null;
  if (s["fade"] !== null) {
    const f = record(s["fade"], ["pace", "countdown", "budget"]);
    fade = {
      pace: number(f["pace"], 0, 255),
      countdown: number(f["countdown"], 0, 65535),
      budget: number(f["budget"], 0, 255),
    };
  }
  return {
    device: number(s["device"], 0, 255),
    active: bool(s["active"]),
    fade,
    // IIgs playback carries a channel per stream (up to 16); other families
    // never exceed four.
    channels: array(s["channels"], 16, (v) => {
      const c = record(v, [
        "cursor",
        "countdown",
        "terminated",
        "base",
        "envelopeIndex",
        "envelopeValue",
      ]);
      return {
        cursor: number(c["cursor"], 0, 65536),
        countdown: number(c["countdown"], 0, 65536),
        terminated: bool(c["terminated"]),
        base: number(c["base"], 0, 15),
        envelopeIndex: number(c["envelopeIndex"], -1, 65536),
        envelopeValue: number(c["envelopeValue"], 0, 15),
      };
    }),
  };
}
export function validateEngineReplayState(
  value: unknown,
  options?: { allowWindow?: boolean },
): EngineReplayState {
  const fields = [
    "clockRemainderMs",
    "pictureShown",
    "terminated",
    "statusRefreshRequested",
    "priorityBase",
    "key",
    "egoHidden",
    "inputReady",
    "saidMatched",
    "controllers",
    "parsedWords",
    "parsedWordTexts",
    "parserCount",
    "lastInputLine",
    "editLine",
    "acceptedLine",
    "inputWidthCap",
    "pendingController",
    "inputQueue",
    "menu",
    "menuFinalized",
    "menuHeading",
    "menuRequested",
    "objectExtras",
    "viewCache",
    "gameSignature",
    "sound",
    "patchGeneration",
    "continuation",
  ];
  const optional = [
    "version",
    "amigaRegion",
    "pcDisplay",
    "monitorType",
    "priorityTableRebuilt",
    "booterClockPhase",
    "pictureRevealInstant",
    "joystick",
    "menuGate",
    "releaseGate",
  ].filter((key) => value !== null && typeof value === "object" && Object.hasOwn(value, key));
  const s = record(value, [...fields, ...optional]);
  if (optional.includes("version") && s["version"] !== 1 && s["version"] !== REPLAY_STATE_VERSION)
    throw new Error("Replay state version is not supported.");
  const hasJoystick = optional.includes("joystick");
  if (s["priorityTableRebuilt"] !== undefined && s["priorityTableRebuilt"] !== true)
    throw new Error("Replay priority table marker must be true.");
  if (s["amigaRegion"] !== undefined && s["amigaRegion"] !== "pal" && s["amigaRegion"] !== "ntsc")
    throw new Error("Replay region must be ntsc or pal.");
  if (s["pcDisplay"] !== undefined && s["pcDisplay"] !== "cga-rgb")
    throw new Error("Replay display must be cga-rgb.");
  const controllers = array(s["controllers"], 256, (v) => number(v, 0, 1));
  const objectExtras = array(s["objectExtras"], 256, (v) => {
    const o = record(v, ["priority"]);
    return { priority: number(o["priority"], 0, 255) };
  });
  if (controllers.length !== 256 || objectExtras.length !== 256)
    throw new Error("Replay state requires all controllers and objects.");
  const cacheValue = s["viewCache"] as Record<string, unknown> | undefined;
  const cache = record(
    cacheValue,
    cacheValue && Object.hasOwn(cacheValue, "loops")
      ? ["loaded", "order", "loops"]
      : ["loaded", "order"],
  );
  const loaded = array(cache["loaded"], 256, (v) => number(v, 0, 255));
  const order = array(cache["order"], 256, (v) => number(v, 0, 255));
  if (
    new Set(loaded).size !== loaded.length ||
    new Set(order).size !== order.length ||
    loaded.some((id) => !order.includes(id))
  )
    throw new Error("Replay state view cache is inconsistent.");
  const viewCache: EngineReplayState["viewCache"] = { loaded, order };
  if (cache["loops"] !== undefined) {
    const loopsValue = cache["loops"];
    if (!loopsValue || typeof loopsValue !== "object" || Array.isArray(loopsValue))
      throw new Error("Replay state view loops must be an object.");
    const loops: Record<string, ViewLoopState[]> = {};
    for (const [key, value] of Object.entries(loopsValue)) {
      if (!loaded.includes(Number(key)) || String(Number(key)) !== key)
        throw new Error("Replay state view loops name a view that is not loaded.");
      loops[key] = array(value, 256, (v) => {
        const l = record(v, ["o", "m", "x"]);
        if (typeof l["m"] !== "boolean" || typeof l["x"] !== "boolean")
          throw new Error("Replay state view loop flags must be booleans.");
        return { o: number(l["o"], 0, 3), m: l["m"], x: l["x"] };
      });
    }
    viewCache.loops = loops;
  }
  const gameSignature = text(s["gameSignature"]);
  if (gameSignature.length > 7) throw new Error("Replay state game signature is too long.");
  let sound: EngineReplayState["sound"] = null;
  if (s["sound"] !== null) {
    const a = record(s["sound"], ["num", "doneFlag", "playback"]);
    sound = {
      num: number(a["num"], 0, 255),
      doneFlag: number(a["doneFlag"], 0, 255),
      playback: validatePlaybackState(a["playback"]),
    };
  }
  const continuation = validateContinuation(s["continuation"], options);
  const joystick = hasJoystick ? validateJoystickState(s["joystick"]) : undefined;
  if (joystick?.calibration != null && continuation?.modals[joystick.calibration]?.kind !== "print")
    throw new Error("Replay joystick calibration is missing its window.");
  return {
    ...(optional.includes("version")
      ? { version: s["version"] as 1 | typeof REPLAY_STATE_VERSION }
      : {}),
    ...(s["amigaRegion"] !== undefined ? { amigaRegion: s["amigaRegion"] as "ntsc" | "pal" } : {}),
    ...(s["pcDisplay"] === "cga-rgb" ? { pcDisplay: "cga-rgb" as const } : {}),
    ...(s["monitorType"] !== undefined ? { monitorType: number(s["monitorType"], 0, 4) } : {}),
    ...(s["priorityTableRebuilt"] === true ? { priorityTableRebuilt: true as const } : {}),
    ...(s["booterClockPhase"] !== undefined
      ? { booterClockPhase: number(s["booterClockPhase"], 1, 17) }
      : {}),
    ...(s["pictureRevealInstant"] !== undefined
      ? { pictureRevealInstant: bool(s["pictureRevealInstant"]) }
      : {}),
    ...(joystick ? { joystick } : {}),
    ...(s["menuGate"] !== undefined ? { menuGate: number(s["menuGate"], 0, 255) } : {}),
    ...(s["releaseGate"] !== undefined ? { releaseGate: number(s["releaseGate"], 0, 255) } : {}),
    clockRemainderMs: number(
      s["clockRemainderMs"],
      0,
      s["amigaRegion"] === "pal" ? 1200 : 1000,
      false,
    ),
    pictureShown: bool(s["pictureShown"]),
    terminated: bool(s["terminated"]),
    statusRefreshRequested: bool(s["statusRefreshRequested"]),
    priorityBase: number(s["priorityBase"], 0, 255),
    key: number(s["key"], 0, 255),
    egoHidden: number(s["egoHidden"], 0, 1),
    inputReady: number(s["inputReady"], 0, 1),
    saidMatched: number(s["saidMatched"], 0, 1),
    controllers,
    parsedWords: array(s["parsedWords"], 10, (v) => number(v, 0, 65535)),
    parsedWordTexts: array(s["parsedWordTexts"], 10, text),
    parserCount: number(s["parserCount"], 0, 255),
    lastInputLine: text(s["lastInputLine"]),
    editLine: text(s["editLine"]),
    acceptedLine: text(s["acceptedLine"]),
    inputWidthCap: nullable(s["inputWidthCap"], 40),
    pendingController: nullable(s["pendingController"]),
    inputQueue: array(s["inputQueue"], 19, (v) => {
      const o = v as InputEvent;
      record(
        v,
        o.mapOnConsume === undefined ? ["type", "value"] : ["type", "value", "mapOnConsume"],
      );
      const type = number(o.type, 1, 3) as 1 | 3 | 2;
      if (o.mapOnConsume !== undefined && o.mapOnConsume !== true)
        throw new Error("Invalid replay input mapping.");
      return {
        type,
        value: number(o.value, 0, 65535),
        ...(o.mapOnConsume ? { mapOnConsume: true as const } : {}),
      };
    }),
    menu: array(s["menu"], 40, (v) => {
      const m = record(v, ["title", "enabled", "current", "items"]);
      return {
        title: text(m["title"]),
        enabled: bool(m["enabled"]),
        current: number(m["current"], 0, 255),
        items: array(m["items"], 255, (v) => {
          const item = record(v, ["text", "id", "enabled"]);
          return {
            text: text(item["text"]),
            id: number(item["id"], 0, 255),
            enabled: bool(item["enabled"]),
          };
        }),
      };
    }),
    menuFinalized: bool(s["menuFinalized"]),
    menuHeading: number(s["menuHeading"], 0, 255),
    menuRequested: bool(s["menuRequested"]),
    objectExtras,
    viewCache,
    gameSignature,
    sound,
    patchGeneration: number(s["patchGeneration"], 0, 0xffffffff),
    continuation,
  };
}
