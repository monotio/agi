/** Host recording state deliberately excluded from authentic save.game images. */
import type { InputEvent } from "./inputQueue.ts";

/**
 * A modal's covered cells, serialized. `cells` are the row-major [char, attr]
 * pairs of the inclusive rect; `written` its per-cell write stamps — together
 * they restore both the text and its age under sprites.
 */
export interface SerializedSavedRect {
  written: number[];
  top: number;
  left: number;
  bottom: number;
  right: number;
  cells: number[];
}

/** A parked modal window; fresh serials are assigned on restore. */
export type SerializedModal =
  | { kind: "print"; saved: SerializedSavedRect; remainingMs: number | null; pauseClock: boolean }
  | {
      kind: "inventory";
      saved: SerializedSavedRect;
      items: { num: number; name: string }[];
      slots: { row: number; col: number }[];
      selected: number;
      interactive: boolean;
    }
  | { kind: "menu"; saved: SerializedSavedRect }
  | { kind: "showObj"; saved: SerializedSavedRect; view: number }
  | { kind: "showPri" };

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
export interface EngineReplayState {
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
  objectExtras: { priority: number }[];
  /** Exact decoded-view residency and allocation order at a harness boundary. */
  viewCache: { loaded: number[]; order: number[] };
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
function savedRect(value: unknown): SerializedSavedRect {
  const s = record(value, ["written", "top", "left", "bottom", "right", "cells"]);
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
  return { written, top, left, bottom, right, cells };
}

function serializedModal(value: unknown): SerializedModal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Replay state requires an object.");
  const kind = (value as Record<string, unknown>)["kind"];
  switch (kind) {
    case "print": {
      const m = record(value, ["kind", "saved", "remainingMs", "pauseClock"]);
      return {
        kind,
        saved: savedRect(m["saved"]),
        pauseClock: bool(m["pauseClock"]),
        remainingMs:
          m["remainingMs"] === null ? null : number(m["remainingMs"], 0, 0xffffffff, false),
      };
    }
    case "inventory": {
      const m = record(value, ["kind", "saved", "items", "slots", "selected", "interactive"]);
      return {
        kind,
        saved: savedRect(m["saved"]),
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
      const m = record(value, ["kind", "saved"]);
      return { kind, saved: savedRect(m["saved"]) };
    }
    case "showObj": {
      const m = record(value, ["kind", "saved", "view"]);
      return { kind, saved: savedRect(m["saved"]), view: number(m["view"], 0, 255) };
    }
    case "showPri":
      record(value, ["kind"]);
      return { kind };
    default:
      throw new Error("Replay state has an unknown modal kind.");
  }
}

/** Validate a serialized parked pass, or null for a non-parked snapshot. */
export function validateContinuation(value: unknown): ParkedContinuation | null {
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
    modals: array(s["modals"], 8, serializedModal),
    persistentWindow: s["persistentWindow"] === null ? null : savedRect(s["persistentWindow"]),
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
export function validateEngineReplayState(value: unknown): EngineReplayState {
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
  const s = record(value, fields);
  const controllers = array(s["controllers"], 256, (v) => number(v, 0, 1));
  const objectExtras = array(s["objectExtras"], 256, (v) => {
    const o = record(v, ["priority"]);
    return { priority: number(o["priority"], 0, 255) };
  });
  if (controllers.length !== 256 || objectExtras.length !== 256)
    throw new Error("Replay state requires all controllers and objects.");
  const cache = record(s["viewCache"], ["loaded", "order"]);
  const loaded = array(cache["loaded"], 256, (v) => number(v, 0, 255));
  const order = array(cache["order"], 256, (v) => number(v, 0, 255));
  if (
    new Set(loaded).size !== loaded.length ||
    new Set(order).size !== order.length ||
    loaded.some((id) => !order.includes(id))
  )
    throw new Error("Replay state view cache is inconsistent.");
  const viewCache = { loaded, order };
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
  return {
    clockRemainderMs: number(s["clockRemainderMs"], 0, 1000, false),
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
      const type = number(o.type, 1, 3) as 1 | 2 | 3;
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
    continuation: validateContinuation(s["continuation"]),
  };
}
