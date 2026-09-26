/**
 * Which rooms and logics use a VIEW, from the logic bytecode alone. A use is
 * a constant view number in `load.view`, `set.view`, `add.to.pic` or
 * `show.obj`. Their variable forms (`load.view.v`, `set.view.v`,
 * `add.to.pic.v`, `show.obj.v`) pick the view at runtime: any view may be
 * the one, so they are reported as `dynamic` for every view.
 *
 * A room is a logic that runs as its own room (the room map's rule: not
 * logic 0 and not only reached through `call`). A room uses a view when its
 * logic does or when a logic it calls by a literal number does, directly or
 * further down the call chain. Logic 0 runs in every room; its uses appear
 * under `logics` only.
 *
 * `add.to.pic` bakes a view's cel into the room's picture when the room is
 * drawn, so a changed view shows there only once the room is entered again;
 * `roomBakesView` answers that for a Keep. Animated objects read the view
 * afresh every frame and need no re-entry.
 */
import { decodeLogicInsns } from "../../logic/disassembler.ts";
import type { AgiProfile } from "../../runtime/profile.ts";
import { scanContainerExits } from "../../agent/roomMap.ts";

/** The operand position of the view number, keyed by constant-form opcode. */
const CONSTANT_VIEW_OPERAND: Record<string, number> = {
  "load.view": 0,
  "set.view": 1,
  "add.to.pic": 0,
  "show.obj": 0,
};

const VARIABLE_VIEW_OPCODES: ReadonlySet<string> = new Set([
  "load.view.v",
  "set.view.v",
  "add.to.pic.v",
  "show.obj.v",
]);

export interface ViewUsage {
  /** Rooms whose logic, or a logic it calls, names the view. */
  readonly rooms: readonly number[];
  /** Logics whose bytecode names the view as a constant. */
  readonly logics: readonly number[];
  /** Some logic chooses a view at runtime, so the lists may be incomplete. */
  readonly dynamic: boolean;
}

export interface ViewUsageIndex {
  /** Constant view numbers each logic names. */
  readonly views: ReadonlyMap<number, ReadonlySet<number>>;
  /** Room logics and the logics each reaches through literal calls, itself included. */
  readonly rooms: ReadonlyMap<number, ReadonlySet<number>>;
  /** Logics with a variable-form view opcode. */
  readonly dynamicLogics: readonly number[];
  /** Constant view numbers each logic bakes into the picture with `add.to.pic`. */
  readonly baked: ReadonlyMap<number, ReadonlySet<number>>;
  /** Logics with `add.to.pic.v`: any view may be baked. */
  readonly dynamicBakers: readonly number[];
}

/** Decode every logic once; query views with `viewUsage`. Undecodable logics name nothing. */
export function scanViewUsage(
  logics: ReadonlyMap<number, Uint8Array>,
  profile?: AgiProfile,
): ViewUsageIndex {
  const views = new Map<number, Set<number>>();
  const baked = new Map<number, Set<number>>();
  const dynamicLogics: number[] = [];
  const dynamicBakers: number[] = [];
  for (const [num, payload] of logics) {
    const named = new Set<number>();
    const bakes = new Set<number>();
    let dynamic = false;
    let dynamicBake = false;
    try {
      for (const insn of decodeLogicInsns(payload, profile ? { profile } : {})) {
        if (insn.kind !== "action" || insn.name === undefined) continue;
        const operand = CONSTANT_VIEW_OPERAND[insn.name];
        if (operand !== undefined && insn.args?.[operand] !== undefined) {
          named.add(insn.args[operand]);
          if (insn.name === "add.to.pic") bakes.add(insn.args[operand]);
        } else if (VARIABLE_VIEW_OPCODES.has(insn.name)) {
          dynamic = true;
          if (insn.name === "add.to.pic.v") dynamicBake = true;
        }
      }
    } catch {
      // A logic that does not decode names no view; the room map degrades the same way.
    }
    views.set(num, named);
    baked.set(num, bakes);
    if (dynamic) dynamicLogics.push(num);
    if (dynamicBake) dynamicBakers.push(num);
  }
  const { scans, shared } = scanContainerExits(logics, profile);
  const rooms = new Map<number, Set<number>>();
  for (const num of logics.keys()) {
    if (shared.has(num)) continue;
    const reached = new Set([num]);
    const pending = [num];
    while (pending.length > 0)
      for (const callee of scans.get(pending.pop()!)?.calls ?? [])
        if (!reached.has(callee) && logics.has(callee)) {
          reached.add(callee);
          pending.push(callee);
        }
    rooms.set(num, reached);
  }
  return {
    views,
    rooms,
    dynamicLogics: dynamicLogics.sort((a, b) => a - b),
    baked,
    dynamicBakers: dynamicBakers.sort((a, b) => a - b),
  };
}

export function viewUsage(index: ViewUsageIndex, view: number): ViewUsage {
  const logics = [...index.views]
    .filter(([, named]) => named.has(view))
    .map(([num]) => num)
    .sort((a, b) => a - b);
  const rooms = [...index.rooms]
    .filter(([, reached]) => logics.some((num) => reached.has(num)))
    .map(([num]) => num)
    .sort((a, b) => a - b);
  return { rooms, logics, dynamic: index.dynamicLogics.length > 0 };
}

/**
 * Whether entering `room` may bake `view` into its picture: logic 0, the
 * room's logic or a logic it calls adds the view with `add.to.pic`, or adds
 * a runtime-chosen view with `add.to.pic.v`.
 */
export function roomBakesView(index: ViewUsageIndex, room: number, view: number): boolean {
  const logics = [0, ...(index.rooms.get(room) ?? [])];
  return logics.some(
    (num) => index.baked.get(num)?.has(view) === true || index.dynamicBakers.includes(num),
  );
}
