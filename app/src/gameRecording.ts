import type { EngineReplayState } from "../../src/runtime/replayState.ts";
import type { RecordedOperation } from "../../src/agent/recordedReplay.ts";
/**
 * Player-action recorder for stored game tests.
 *
 * The engine worker (engine.worker.ts) captures what the player actually did,
 * stamped at interpreter cycle boundaries: command lines, PC key words,
 * direction holds and releases, prompt answers and printed messages, plus the
 * host snapshot at record-start. Exact clock ticks, host replies and engine
 * calls form a bounded operation tape; player events are only UI metadata.
 * Recorded tests retain the same expectations as authored tests without
 * pretending a host callback is an ordinary logic cycle. No browser globals.
 */

/** One captured player action, stamped with the worker's interpreter cycle. */
export type RecordedEvent =
  | { cycle: number; kind: "command"; text: string }
  | { cycle: number; kind: "key"; code: number }
  /** Hold-to-move direction press; the run ends at the matching release. */
  | { cycle: number; kind: "direction"; dir: number }
  /** Hold-to-move key release (the runner's direction-0 cycle). */
  | { cycle: number; kind: "release" }
  /** A get.string / get.num prompt the player answered. */
  | { cycle: number; kind: "answer"; text: string };

/** The slice of engine.readState() the assertion diff works on. */
export interface RecorderStateSnapshot {
  room: number;
  vars: readonly number[];
  flags: readonly number[];
  inventory: readonly { num: number; name?: string; room: number }[];
}

/** What the worker captured between startRecording and stopRecording. */
export interface RecordingSnapshot {
  start: {
    image: string;
    cycle: number;
    state: RecorderStateSnapshot;
    replayState: EngineReplayState;
  };
  operations: RecordedOperation[];
  events: readonly RecordedEvent[];
  printed: readonly string[];
  endState: RecorderStateSnapshot;
  endCycle: number;
  /** Set when the recording can no longer describe the live game. */
  tainted: string | null;
  /** Retained UI compatibility field; numeric prompts now replay through the operation tape. */
  usedGetnum: boolean;
}

/** One checkbox in the stop dialog: a state diff worth asserting, preselected when meaningful. */
export interface AssertionSuggestion {
  readonly id: string;
  readonly kind: "room" | "flag" | "var" | "score" | "item" | "printed";
  readonly label: string;
  selected: boolean;
  readonly room?: number;
  readonly flag?: { id: number; value: boolean };
  readonly var?: { id: number; value: number };
  readonly score?: number;
  readonly item?: number;
  readonly printed?: string;
}

/**
 * Interpreter-owned variables the assertion diff never suggests: room and
 * edge bookkeeping (0-2), the score (3, suggested on its own), object-edge
 * (4-5), ego heading (6), max score (7), free script pages (8), parser counts
 * (9), the cycle-time setting (10), ego view (16), error registers (17-18),
 * the last key (19), the window timer (21) and the sound device (22).
 * Everything else that changed is a candidate game variable.
 */
const INTERPRETER_VARS: Readonly<Record<number, true>> = {
  0: true,
  1: true,
  2: true,
  3: true,
  4: true,
  5: true,
  6: true,
  7: true,
  8: true,
  9: true,
  10: true,
  16: true,
  17: true,
  18: true,
  19: true,
  21: true,
  22: true,
};

/**
 * Diff the record-start and stop states into checkbox suggestions: flags set
 * or cleared, game variables changed, items picked up, the room (a room
 * transition is implicit in the steps, so the expectation is how a recording
 * pins it) and the latest printed messages. Meaningful diffs start checked;
 * the unchanged room and older prints are offered unchecked.
 */
export function suggestAssertions(
  start: RecorderStateSnapshot,
  end: RecorderStateSnapshot,
  printed: readonly string[],
): AssertionSuggestion[] {
  const suggestions: AssertionSuggestion[] = [];
  suggestions.push({
    id: "room",
    kind: "room",
    room: end.room,
    label: end.room === start.room ? `room ${end.room} (unchanged)` : `room ${end.room}`,
    selected: end.room !== start.room,
  });
  for (let id = 0; id < 256; id++) {
    const before = (start.flags[id] ?? 0) !== 0;
    const after = (end.flags[id] ?? 0) !== 0;
    if (before !== after)
      suggestions.push({
        id: `flag-${id}`,
        kind: "flag",
        flag: { id, value: after },
        label: `f${id} ${after ? "set" : "cleared"}`,
        selected: true,
      });
  }
  const score = end.vars[3] ?? 0;
  if (score !== (start.vars[3] ?? 0))
    suggestions.push({
      id: "score",
      kind: "score",
      score,
      label: `score ${score}`,
      selected: true,
    });
  for (let id = 0; id < 256; id++) {
    if (INTERPRETER_VARS[id]) continue;
    const after = end.vars[id] ?? 0;
    if ((start.vars[id] ?? 0) !== after)
      suggestions.push({
        id: `var-${id}`,
        kind: "var",
        var: { id, value: after },
        label: `v${id} = ${after}`,
        selected: true,
      });
  }
  const carriedBefore = new Set(
    start.inventory.filter((item) => item.room === 255).map((item) => item.num),
  );
  for (const item of end.inventory)
    if (item.room === 255 && !carriedBefore.has(item.num))
      suggestions.push({
        id: `item-${item.num}`,
        kind: "item",
        item: item.num,
        label: `carrying ${item.name?.trim() || `item ${item.num}`}`,
        selected: true,
      });
  const recent = printed
    .map((text) => text.trim().replace(/\s+/g, " "))
    .filter((text) => text.length > 0)
    .slice(-3);
  recent.forEach((text, index) => {
    suggestions.push({
      id: `printed-${index}`,
      kind: "printed",
      printed: text.slice(0, 200),
      label: `printed “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
      selected: index === recent.length - 1,
    });
  });
  return suggestions;
}

/**
 * Assemble the stored test for write_game_tests: the record-start room (the
 * state the setup image replays from), the setup image, the stamped steps and
 * the expectations the player kept checked. Sparse steps/expect are
 * deliberate — the shared validators normalize them, and sparse JSON is what
 * a hand-authored test looks like.
 */
export function buildRecordedTest(
  name: string,
  snapshot: RecordingSnapshot,
  selected: readonly AssertionSuggestion[],
): Record<string, unknown> {
  if (snapshot.tainted) throw new Error(snapshot.tainted);
  const flags = selected.flatMap((s) => (s.kind === "flag" && s.flag ? [s.flag] : []));
  const vars = selected.flatMap((s) => (s.kind === "var" && s.var ? [s.var] : []));
  const carriedItems = selected.flatMap((s) =>
    s.kind === "item" && s.item !== undefined ? [s.item] : [],
  );
  const room = selected.find((s) => s.kind === "room")?.room;
  const score = selected.find((s) => s.kind === "score")?.score;
  const printed = selected.filter((s) => s.kind === "printed").at(-1)?.printed;
  const expect: Record<string, unknown> = {
    ...(room !== undefined ? { room } : {}),
    ...(carriedItems.length ? { carriedItems } : {}),
    ...(flags.length ? { flags } : {}),
    ...(vars.length ? { vars } : {}),
    ...(printed !== undefined ? { printed } : {}),
    ...(score !== undefined ? { score } : {}),
  };
  return {
    name,
    room: snapshot.start.state.room,
    spawnX: null,
    spawnY: null,
    setup: {
      image: snapshot.start.image,
      replay: JSON.stringify({
        state: snapshot.start.replayState,
        operations: snapshot.operations,
      }),
    },
    steps: [],
    expect: Object.keys(expect).length ? expect : null,
    cycleBudget: Math.max(1, snapshot.operations.filter((op) => op[0] === "tick").length),
  };
}
