/**
 * The HISTORY.JSON contract for project archives: the recording plus its
 * sibling records — the retained original and the bookmarks — so a project
 * moved to another browser replays with the same tape and the same kept
 * session. The `committed`/`bytes` dedup maps are transport bookkeeping and
 * do not travel.
 *
 * This module is pure data validation and serialization — no storage — so
 * the ZIP readers can reach it without pulling IndexedDB into programs that
 * run outside the app's DOM typings.
 */
import {
  validateHistoryBoot,
  validateHistoryRecording,
  type HistoryBoot,
  type HistoryRecording,
} from "../../src/agent/history.ts";

/**
 * A session Resume from here swapped away from: a full resume point plus the
 * tape position it paused at. A bounded list is kept per game — repeated
 * rewinds preserve earlier branches rather than overwrite the one undo copy.
 */
export interface RetainedOriginal {
  /** Stable key for the branch slot — staging, commit and restore name it. */
  id: string;
  boot: HistoryBoot;
  /** The departing session's tape position; null outside an open segment. */
  from: { segment: string; seq: number; tick: number } | null;
  retainedAt: number;
  /**
   * The departing session's authoring state (sources, bindings, world plan)
   * at retain time — reinstalled on a Back-to-before adoption so the
   * session works from the bytes it is shown, not the future it left.
   */
  session?: Record<string, unknown>;
}

/** A player-placed mark on the recording. */
export interface HistoryBookmark {
  segment: string;
  seq: number;
  tick: number;
  label: string;
  at: number;
}

/** What a project archive's HISTORY.JSON carries. */
export interface ProjectHistory {
  recording: HistoryRecording;
  /** Kept recovery branches, oldest first — the rewind undo list. */
  branches?: RetainedOriginal[];
  /**
   * Departing sessions whose swap the worker never settled — an uncertain
   * adoption's recovery copy. Imported entries stay unsettled: the new
   * browser cannot know whether the swap committed, so the staged slot is
   * preserved for the settle-on-boot pass to resolve.
   */
  staged?: RetainedOriginal[];
  bookmarks?: HistoryBookmark[];
}

/** The serialized HISTORY.JSON entry. */
export function historyArchiveData(history: ProjectHistory): string {
  return JSON.stringify({ format: "monotio.agi.history", version: 1, ...history });
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRetained(value: RetainedOriginal): RetainedOriginal | null {
  try {
    if (typeof value.id !== "string" || value.id === "") return null;
    validateHistoryBoot(value.boot);
    if (value.from !== null) {
      const from = value.from;
      if (
        typeof from !== "object" ||
        typeof from.segment !== "string" ||
        !Number.isInteger(from.seq) ||
        !Number.isInteger(from.tick)
      )
        return null;
    }
    if (value.session !== undefined && !isObj(value.session)) return null;
    return value;
  } catch {
    return null;
  }
}

/** A HISTORY.JSON entry from a project archive, validated like any untrusted input. */
export function readHistoryArchive(bytes: Uint8Array): ProjectHistory {
  if (bytes.length > 96 * 1024 * 1024) throw new Error("HISTORY.JSON is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("HISTORY.JSON contains invalid JSON.");
  }
  if (!isObj(raw) || raw["format"] !== "monotio.agi.history" || raw["version"] !== 1)
    throw new Error("HISTORY.JSON is not a history record this app understands.");
  const recording = validateHistoryRecording(raw["recording"]);
  const retainedList = (key: "branches" | "staged"): RetainedOriginal[] => {
    const entry = key === "branches" ? "retained branch" : "staged candidate";
    const rawList = raw[key] ?? [];
    if (!Array.isArray(rawList) || rawList.length > 16)
      throw new Error(`HISTORY.JSON ${key} are invalid.`);
    return rawList.map((value) => {
      if (!isObj(value) || !Number.isFinite(value["retainedAt"]))
        throw new Error(`HISTORY.JSON ${entry} is invalid.`);
      const checked = validateRetained(value as unknown as RetainedOriginal);
      if (checked === null) throw new Error(`HISTORY.JSON ${entry} is invalid.`);
      return checked;
    });
  };
  const branches = retainedList("branches");
  const staged = retainedList("staged");
  let bookmarks: HistoryBookmark[] | undefined;
  if (raw["bookmarks"] !== undefined) {
    const list = raw["bookmarks"];
    if (!Array.isArray(list) || list.length > 500)
      throw new Error("HISTORY.JSON bookmarks are invalid.");
    bookmarks = list.map((b) => {
      if (
        !isObj(b) ||
        typeof b["segment"] !== "string" ||
        b["segment"].length > 64 ||
        !Number.isInteger(b["seq"]) ||
        !Number.isInteger(b["tick"]) ||
        typeof b["label"] !== "string" ||
        b["label"].length > 200 ||
        !Number.isFinite(b["at"])
      )
        throw new Error("HISTORY.JSON bookmark is invalid.");
      const bookmark: HistoryBookmark = {
        segment: b["segment"],
        seq: b["seq"] as number,
        tick: b["tick"] as number,
        label: b["label"],
        at: b["at"] as number,
      };
      return bookmark;
    });
  }
  return {
    recording,
    ...(branches.length > 0 ? { branches } : {}),
    ...(staged.length > 0 ? { staged } : {}),
    ...(bookmarks !== undefined ? { bookmarks } : {}),
  };
}
