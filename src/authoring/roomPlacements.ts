/** Static room-entry figures, using the guided editor's parsed source and exact operand spans. */
import {
  callArgSpan,
  initBlocks,
  parseRoomSource,
  spliceText,
  type ParsedRoom,
} from "./guidedSource.ts";
import { VAR_WRITES } from "../agent/roomFlow.ts";
import type { Ref, Stmt, TestExpr } from "../logic/syntax.ts";

/** One place the room may draw a figure, when the entry offers more than one. */
export interface PlacementSpot {
  readonly x: number;
  readonly y: number;
  readonly logic: number;
  readonly command: string;
  readonly offset: number;
}
export interface RoomPlacement {
  readonly object: number;
  readonly view: number | null;
  readonly loop: number | null;
  readonly cel: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly logic: number;
  readonly reason: string | null;
  readonly command: string;
  readonly offset: number;
  /** The drawn spots the analysis saw; more than one marks a conditional placement. */
  readonly spots: readonly PlacementSpot[];
}
interface Figure {
  object: number;
  view: number | null;
  loop: number | null;
  cel: number | null;
  x: number | null;
  y: number | null;
  logic: number;
  reason: string | null;
  command: string;
  offset: number;
  animated: boolean;
  drawn: boolean;
  conditional: boolean;
  spots: PlacementSpot[];
}
interface State {
  vars: Map<number, number | null>;
  figures: Map<number, Figure>;
  flags: Map<number, boolean | null>;
  opaque: boolean;
}
type Input = {
  room: number;
  sources: Readonly<Record<string, string>>;
  bindings?: Readonly<Record<string, { readonly num: number }>>;
};
const number = (ref: Ref | undefined): number | null =>
  ref?.kind === "num" ? ref.value : ref?.kind === "o" ? ref.index : null;
function clone(state: State): State {
  return {
    vars: new Map(state.vars),
    figures: new Map([...state.figures].map(([n, f]) => [n, { ...f, spots: [...f.spots] }])),
    flags: new Map(state.flags),
    opaque: state.opaque,
  };
}
function truth(test: TestExpr, state: State): boolean | null {
  if (test.type === "group") return truth(test.inner, state);
  if (test.type === "not") {
    const value = truth(test.inner, state);
    return value === null ? null : !value;
  }
  if (test.type === "and" || test.type === "or") {
    const values = test.parts.map((part) => truth(part, state));
    const decisive = test.type === "and" ? false : true;
    return values.includes(decisive) ? decisive : values.includes(null) ? null : !decisive;
  }
  if (test.name === "isset" && test.args[0]?.kind === "f")
    return state.flags.get(test.args[0].index) ?? null;
  if (["equaln", "lessn", "greatern"].includes(test.name)) {
    const ref = test.args[0];
    const a = ref?.kind === "v" ? state.vars.get(ref.index) : null;
    const b = number(test.args[1]);
    if (a === null || a === undefined || b === null) return null;
    return test.name === "equaln" ? a === b : test.name === "lessn" ? a < b : a > b;
  }
  return null;
}
function join(into: State, a: State, b: State): void {
  into.opaque = a.opaque || b.opaque;
  for (const key of new Set([...a.flags.keys(), ...b.flags.keys()])) {
    const left = a.flags.get(key);
    const right = b.flags.get(key);
    into.flags.set(key, left === right ? (left ?? null) : null);
  }
  for (const key of new Set([...a.vars.keys(), ...b.vars.keys()])) {
    const left = a.vars.get(key);
    const right = b.vars.get(key);
    into.vars.set(key, left === right ? (left ?? null) : null);
  }
  into.figures.clear();
  for (const key of new Set([...a.figures.keys(), ...b.figures.keys()])) {
    const left = a.figures.get(key);
    const right = b.figures.get(key);
    const f = { ...(left ?? right)! };
    f.conditional =
      !left || !right || left.conditional || right.conditional || left.drawn !== right.drawn;
    f.spots = mergeSpots(left?.spots ?? [], right?.spots ?? []);
    if (left && right) {
      for (const property of ["view", "loop", "cel", "x", "y"] as const)
        if (left[property] !== right[property])
          f[property] =
            left[property] === null
              ? right[property]
              : right[property] === null
                ? left[property]
                : null;
      if (left.offset !== right.offset || left.reason || right.reason)
        f.reason = "Conditional placement";
      f.drawn = left.drawn || right.drawn;
    } else f.reason = "Conditional placement";
    into.figures.set(key, f);
  }
}
/** The drawn spots of two joined paths, one entry per distinct position line. */
function mergeSpots(
  left: readonly PlacementSpot[],
  right: readonly PlacementSpot[],
): PlacementSpot[] {
  const seen = new Set<string>();
  const spots: PlacementSpot[] = [];
  for (const spot of [...left, ...right]) {
    const key = `${spot.x},${spot.y},${spot.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spots.push(spot);
  }
  return spots.slice(0, 16);
}

/** Unknown paths retain their cause; coordinates with conflicting values stay unknown. */
export function roomPlacements(input: Input): RoomPlacement[] {
  const parsed = new Map<number, ParsedRoom>();
  const parse = (logic: number): ParsedRoom | undefined => {
    if (parsed.has(logic)) return parsed.get(logic);
    const source = input.sources[`logic:${logic}`];
    if (source === undefined) return undefined;
    try {
      const room = parseRoomSource(source, input.bindings ?? {});
      parsed.set(logic, room);
      return room;
    } catch {
      /* An incomplete source supplies no writable placements. */
      return undefined;
    }
  };
  const state: State = {
    vars: new Map([[0, input.room]]),
    figures: new Map(),
    flags: new Map([[5, true]]),
    opaque: false,
  };
  const stack = new Set<number>();
  const invalidate = () => {
    for (const f of state.figures.values()) f.reason = "Entry calls custom LOGIC";
  };
  const run = (logic: number, current: State, conditional = false, entryOnly = false): void => {
    const room = parse(logic);
    if (!room || stack.has(logic)) {
      current.opaque = true;
      current.vars.clear();
      current.flags.clear();
      for (const f of current.figures.values()) f.reason = "Entry calls custom LOGIC";
      return;
    }
    stack.add(logic);
    const statements = (body: readonly Stmt[], uncertain: boolean): boolean => {
      for (const stmt of body) {
        if (stmt.type === "return") return false;
        if (stmt.type === "goto") {
          for (const f of current.figures.values()) f.reason = "Entry uses a jump";
          return false;
        }
        if (stmt.type === "if") {
          const value = truth(stmt.test, current);
          if (value !== null) {
            if (!statements(value ? stmt.then : (stmt.else_ ?? []), uncertain)) return false;
          } else {
            const before = clone(current);
            const thenContinues = statements(stmt.then, true);
            const yes = clone(current);
            current.vars = before.vars;
            current.figures = before.figures;
            current.flags = before.flags;
            current.opaque = before.opaque;
            const elseContinues = statements(stmt.else_ ?? [], true);
            join(current, yes, clone(current));
            if (!thenContinues && !elseContinues) return false;
            if (!thenContinues || !elseContinues) uncertain = true;
          }
          continue;
        }
        if (stmt.type !== "action") continue;
        const args = stmt.args;
        const value = (arg: Ref | undefined): number | null =>
          arg?.kind === "v" ? (current.vars.get(arg.index) ?? null) : number(arg);
        if (["set", "reset", "toggle"].includes(stmt.name) && args[0]?.kind === "f") {
          const flag = args[0].index;
          const old = current.flags.get(flag);
          current.flags.set(
            flag,
            stmt.name === "set"
              ? true
              : stmt.name === "reset"
                ? false
                : old === undefined || old === null
                  ? null
                  : !old,
          );
          continue;
        }
        if (["set.v", "reset.v", "toggle.v"].includes(stmt.name)) current.flags.clear();
        if (stmt.name === "assignn" || stmt.name === "assignv") {
          if (args[0]?.kind === "v") current.vars.set(args[0].index, value(args[1]));
          continue;
        }
        if (stmt.name === "call" || stmt.name === "call.v") {
          const target = value(args[0]);
          if (target === null) {
            current.opaque = true;
            for (const f of current.figures.values()) f.reason = "Entry calls computed LOGIC";
            current.vars.clear();
            current.flags.clear();
          } else run(target, current, uncertain);
          continue;
        }
        if (stmt.name === "new.room" || stmt.name === "new.room.v") return false;
        for (const pos of VAR_WRITES[stmt.name] ?? []) {
          const arg = args[pos];
          if (arg?.kind === "v") current.vars.set(arg.index, null);
        }
        if (stmt.name === "lindirectn" || stmt.name === "lindirectv") current.vars.clear();
        if (stmt.name === "unanimate.all") {
          current.figures.clear();
          continue;
        }
        const object = number(args[0]);
        if (object === null) continue;
        let f = current.figures.get(object);
        if (stmt.name === "animate.obj") {
          f = {
            object,
            view: null,
            loop: 0,
            cel: 0,
            x: null,
            y: null,
            logic,
            reason: uncertain ? "Conditional placement" : null,
            command: "position",
            offset: -1,
            animated: true,
            drawn: false,
            conditional: uncertain,
            spots: [],
          };
          current.figures.set(object, f);
        }
        if (!f) continue;
        if (
          ["set.view", "set.view.v", "set.loop", "set.loop.v", "set.cel", "set.cel.v"].includes(
            stmt.name,
          )
        ) {
          const property = stmt.name.startsWith("set.view")
            ? "view"
            : stmt.name.startsWith("set.loop")
              ? "loop"
              : "cel";
          f[property] = value(args[1]);
        }
        if (["position", "position.v", "reposition.to", "reposition.to.v"].includes(stmt.name)) {
          f.x = value(args[1]);
          f.y = value(args[2]);
          f.logic = logic;
          f.command = stmt.name;
          f.offset = stmt.tok.start - room.base;
          f.reason = current.opaque
            ? "Entry calls computed LOGIC"
            : uncertain || f.conditional
              ? "Conditional placement"
              : stmt.name.endsWith(".v")
                ? `${stmt.name} uses variables`
                : f.view === null
                  ? "VIEW is chosen at run time"
                  : null;
        }
        if (stmt.name === "draw") {
          f.drawn = true;
          if (f.x !== null && f.y !== null)
            f.spots = mergeSpots(f.spots, [
              { x: f.x, y: f.y, logic: f.logic, command: f.command, offset: f.offset },
            ]);
          if (uncertain) {
            f.conditional = true;
            f.reason = "Conditional placement";
          }
        }
        if (stmt.name === "erase") f.drawn = false;
      }
      return true;
    };
    statements(entryOnly ? initBlocks(room.program) : room.program, conditional);
    stack.delete(logic);
  };
  // Shared entry setup supplies the hero's VIEW. The room's own entry is
  // analyzed independently of shared menus and per-cycle death handlers.
  if (input.room !== 0 && input.sources["logic:0"] !== undefined) run(0, state, false, true);
  run(input.room, state);
  if (!parsed.has(input.room)) invalidate();
  return [...state.figures.values()]
    .filter((f) => f.animated && f.drawn)
    .map(({ animated: _animated, drawn: _drawn, conditional: _conditional, ...f }) => f);
}

/** Re-read the source at drop; only a still-provable placement can be changed. */
export function moveRoomPlacement(
  input: Input,
  figure: RoomPlacement,
  x: number,
  y: number,
): string {
  const current = roomPlacements(input).find((f) => f.object === figure.object);
  if (
    !current ||
    current.reason ||
    current.logic !== figure.logic ||
    current.offset !== figure.offset ||
    current.x !== figure.x ||
    current.y !== figure.y ||
    current.command !== figure.command
  )
    throw new Error("This placement changed. Open the picture again.");
  const source = input.sources[`logic:${current.logic}`]!;
  const room = parseRoomSource(source, input.bindings ?? {});
  let action: Stmt | undefined;
  const find = (body: readonly Stmt[]): void => {
    for (const s of body) {
      if (s.tok.start - room.base === current.offset) action = s;
      if (s.type === "if") {
        find(s.then);
        find(s.else_ ?? []);
      }
    }
  };
  find(room.program);
  const xs = action && callArgSpan(room, action, 1);
  const ys = action && callArgSpan(room, action, 2);
  if (
    !xs ||
    !ys ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x > 159 ||
    y < 0 ||
    y > 167
  )
    throw new Error("Choose a position inside the picture.");
  return spliceText(source, [
    { ...xs, text: String(x) },
    { ...ys, text: String(y) },
  ]).text;
}
