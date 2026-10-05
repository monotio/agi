/** Constant-set data flow for map candidates; this never executes game code. */
import { decodeLogicInsns } from "../logic/disassembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";

type Insn = ReturnType<typeof decodeLogicInsns>[number];
interface Value {
  readonly numbers: readonly number[];
  readonly unknown: boolean;
  readonly widened?: boolean;
}
type State = Map<number, Value>;
const UNKNOWN: Value = { numbers: [], unknown: true };
// Room routes use small constant sets. Widen array/counter-sized sets so a
// game with table-building loops still yields a responsive partial map.
const MAX_CONSTANTS = 16;
const WIDENED: Value = { numbers: [], unknown: true, widened: true };
const literal = (number: number): Value => ({ numbers: [number], unknown: false });

/** Argument positions whose variables receive a value from the interpreter. */
export const VAR_WRITES: Readonly<Record<string, readonly number[]>> = {
  increment: [0],
  decrement: [0],
  assignn: [0],
  assignv: [0],
  addn: [0],
  addv: [0],
  subn: [0],
  subv: [0],
  muln: [0],
  mulv: [0],
  divn: [0],
  divv: [0],
  rindirect: [0],
  random: [2],
  "get.posn": [1, 2],
  "last.cel": [1],
  "current.cel": [1],
  "current.loop": [1],
  "current.view": [1],
  "number.of.loops": [1],
  "get.priority": [1],
  "get.dir": [1],
  "get.room.v": [1],
  "get.num": [1],
  distance: [2],
};

export interface FlowScan {
  targets: { to: number; edge?: "top" | "right" | "bottom" | "left" }[];
  variableTarget: boolean;
  calls: number[];
  unresolvedCall: boolean;
  roomEvidence: boolean;
}
const SIDES = [undefined, "top", "right", "bottom", "left"] as const;
type Side = NonNullable<(typeof SIDES)[number]>;

function union(a: Value, b: Value): Value {
  if (a === b) return a;
  if (a.widened || b.widened) return WIDENED;
  if (!b.numbers.length && (a.unknown || !b.unknown)) return a;
  if (!a.numbers.length && (b.unknown || !a.unknown)) return b;
  if ((!b.unknown || a.unknown) && b.numbers.every((n) => a.numbers.includes(n))) return a;
  if ((!a.unknown || b.unknown) && a.numbers.every((n) => b.numbers.includes(n))) return b;
  const numbers = [...a.numbers];
  for (const number of b.numbers) {
    if (numbers.includes(number)) continue;
    numbers.push(number);
    if (numbers.length > MAX_CONSTANTS) return WIDENED;
  }
  numbers.sort((x, y) => x - y);
  return numbers.length > MAX_CONSTANTS ? WIDENED : { numbers, unknown: a.unknown || b.unknown };
}
function same(a: Value, b: Value): boolean {
  if (a === b) return true;
  return (
    a.unknown === b.unknown &&
    a.widened === b.widened &&
    a.numbers.length === b.numbers.length &&
    a.numbers.every((n, i) => n === b.numbers[i])
  );
}
function join(into: State, incoming: State): boolean {
  let changed = false;
  for (const [variable, old] of into) {
    const value = union(old, incoming.get(variable) ?? UNKNOWN);
    if (!same(old, value)) {
      into.set(variable, value);
      changed = true;
    }
  }
  for (const [variable, value] of incoming)
    if (!into.has(variable) && value.numbers.length) {
      into.set(variable, union(UNKNOWN, value));
      changed = true;
    }
  return changed;
}
function clear(state: State): void {
  for (const variable of state.keys()) state.set(variable, UNKNOWN);
}

interface Guard {
  variable: number;
  constant: number;
  comparison: string;
  negated: boolean;
}
function guards(text: string, relevant: ReadonlySet<number>): { clauses: number; guards: Guard[] } {
  const clauses = text.split(" && ");
  const guards: Guard[] = [];
  for (const clause of clauses) {
    const match = /^(!?)(equaln|greatern|lessn)\(v(\d+), (\d+)\)$/.exec(clause);
    if (match && relevant.has(Number(match[3])))
      guards.push({
        variable: Number(match[3]),
        constant: Number(match[4]),
        comparison: match[2]!,
        negated: match[1] === "!",
      });
  }
  return { clauses: clauses.length, guards };
}
/** Refine simple numeric guards on both branches. Other predicates stay possible. */
function branch(state: State, conditions: ReturnType<typeof guards>, truth: boolean): State | null {
  if ((!truth && conditions.clauses !== 1) || !conditions.guards.length) return state;
  const next = new Map(state);
  for (const { variable, constant, comparison, negated } of conditions.guards) {
    const positive = truth !== negated;
    const accepts = (n: number): boolean =>
      (comparison === "equaln"
        ? n === constant
        : comparison === "greatern"
          ? n > constant
          : n < constant) === positive;
    const value = next.get(variable) ?? UNKNOWN;
    const numbers = value.numbers.filter(accepts);
    if (variable !== 0 && value.unknown && comparison === "equaln" && positive)
      next.set(variable, literal(constant));
    else {
      if (!numbers.length && !value.unknown) return null;
      next.set(variable, value.widened ? WIDENED : { numbers, unknown: value.unknown });
    }
  }
  return next;
}
function edgeAt(insns: readonly Insn[], at: number, inherited?: Side): Side | undefined {
  let side = inherited;
  let span = Infinity;
  for (const insn of insns) {
    if (insn.kind !== "if" || at < insn.end || at >= insn.target || insn.target - insn.end >= span)
      continue;
    for (const clause of (insn.text ?? "").split(" && ")) {
      const match = /^equaln\(v2, (\d+)\)$/.exec(clause);
      const candidate = match ? SIDES[Number(match[1])] : undefined;
      if (candidate) {
        side = candidate;
        span = insn.target - insn.end;
      }
    }
  }
  return side;
}
function evidence(insn: Insn, insns: readonly Insn[]): boolean {
  if (["load.pic", "draw.pic", "overlay.pic"].includes(insn.name ?? "")) return true;
  return (
    insn.args?.[0] === 0 &&
    ["position", "position.v", "draw", "animate.obj", "set.view", "set.view.v"].includes(
      insn.name ?? "",
    ) &&
    insns.some(
      (i) =>
        i.kind === "if" &&
        (i.text ?? "").split(" && ").includes("isset(f5)") &&
        insn.at >= i.end &&
        insn.at < i.target,
    )
  );
}

export function createRoomFlow(
  logics: ReadonlyMap<number, Uint8Array>,
  profile?: AgiProfile,
): {
  scan: (logic: number, room?: number, main?: boolean) => FlowScan;
  instructions: ReadonlyMap<number, readonly Insn[]>;
  work: Readonly<{ steps: number; summaries: number; hits: number }>;
} {
  const instructions = new Map<number, readonly Insn[]>();
  for (const [num, payload] of logics) {
    try {
      instructions.set(num, decodeLogicInsns(payload, profile ? { profile } : {}));
    } catch {
      instructions.set(num, []);
    }
  }
  const relevant = new Set<number>([0]);
  for (const insns of instructions.values())
    for (const insn of insns) {
      if (["new.room.v", "call.v"].includes(insn.name ?? "")) relevant.add(insn.args![0]!);
    }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const insns of instructions.values())
      for (const insn of insns)
        if (
          insn.name === "assignv" &&
          relevant.has(insn.args![0]!) &&
          !relevant.has(insn.args![1]!)
        ) {
          relevant.add(insn.args![1]!);
          expanded = true;
        }
  }
  // Wholly constant assignment sets supply persisted candidates from other
  // LOGICs. The incoming value remains uncertain until this call tree assigns
  // it; the graph records candidates separately from observed crossings.
  const globals: State = new Map();
  const copies: [number, number][] = [];
  for (const insns of instructions.values())
    for (const insn of insns) {
      const args = insn.args ?? [];
      if (insn.name === "assignn") {
        const old = globals.get(args[0]!);
        globals.set(args[0]!, old ? union(old, literal(args[1]!)) : literal(args[1]!));
      } else if (insn.name === "assignv") copies.push([args[0]!, args[1]!]);
      else
        for (const pos of VAR_WRITES[insn.name ?? ""] ?? []) {
          const variable = args[pos]!;
          globals.set(variable, union(globals.get(variable) ?? UNKNOWN, UNKNOWN));
        }
    }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [to, from] of copies) {
      const old = globals.get(to);
      const value = old ? union(old, globals.get(from) ?? UNKNOWN) : (globals.get(from) ?? UNKNOWN);
      if (!old || !same(old, value)) {
        globals.set(to, value);
        changed = true;
      }
    }
  }
  // v0 and v1 belong to the interpreter, rather than authored assignments.
  globals.delete(0);
  globals.delete(1);

  const dependencies = new Map<number, Set<number>>();
  for (const [num, insns] of instructions) {
    const vars = new Set<number>();
    for (const insn of insns) {
      for (const match of (insn.text ?? "").matchAll(/v(\d+)/g))
        if (relevant.has(Number(match[1]))) vars.add(Number(match[1]));
      for (const pos of VAR_WRITES[insn.name ?? ""] ?? [])
        if (relevant.has(insn.args![pos]!)) vars.add(insn.args![pos]!);
      if (insn.name === "assignv" && relevant.has(insn.args![0]!)) vars.add(insn.args![1]!);
      if (["new.room.v", "call.v"].includes(insn.name ?? "")) vars.add(insn.args![0]!);
      if (["lindirectn", "lindirectv", "call.v"].includes(insn.name ?? ""))
        for (const variable of relevant) vars.add(variable);
    }
    dependencies.set(num, vars);
  }
  let dependenciesChanged = true;
  while (dependenciesChanged) {
    dependenciesChanged = false;
    for (const [num, insns] of instructions)
      for (const insn of insns) {
        if (insn.name !== "call") continue;
        const vars = dependencies.get(num)!;
        for (const variable of dependencies.get(insn.args![0]!) ?? relevant)
          if (!vars.has(variable)) {
            vars.add(variable);
            dependenciesChanged = true;
          }
      }
  }

  // Helpers that only touch unrelated data or perform unknown writes need
  // no path enumeration. Their complete call trees have no room exit and
  // cannot produce a constant used by one; merge their possible clobbers.
  const opaque = new Set<number>();
  for (const [num, insns] of instructions)
    if (
      !insns.some(
        (i) =>
          ["new.room", "new.room.v", "call.v"].includes(i.name ?? "") ||
          (["assignn", "assignv"].includes(i.name ?? "") && relevant.has(i.args![0]!)),
      )
    )
      opaque.add(num);
  let removed = true;
  while (removed) {
    removed = false;
    for (const num of opaque)
      if (instructions.get(num)!.some((i) => i.name === "call" && !opaque.has(i.args![0]!))) {
        opaque.delete(num);
        removed = true;
      }
  }
  // Instruction metadata is independent of entry state. Build it once rather
  // than repeating guard/evidence searches inside the fixpoint worklist.
  const metadata = new Map(
    [...instructions].map(([num, insns]) => {
      const next = new Map<number, number>();
      const entries = new Map(
        insns.map((i) => [
          i.at,
          {
            insn: i,
            evidence: evidence(i, insns),
            side: ["new.room", "new.room.v", "call", "call.v"].includes(i.name ?? "")
              ? edgeAt(insns, i.at)
              : undefined,
            guards: guards(i.kind === "if" ? (i.text ?? "") : "", relevant),
          },
        ]),
      );
      let nextAt = -1;
      for (const insn of [...insns].reverse()) {
        if (
          insn.kind !== "action" ||
          ["new.room", "new.room.v", "call", "call.v", "lindirectn", "lindirectv"].includes(
            insn.name ?? "",
          ) ||
          entries.get(insn.at)!.evidence ||
          (VAR_WRITES[insn.name ?? ""] ?? []).some((pos) => relevant.has(insn.args![pos]!))
        )
          nextAt = insn.at;
        next.set(insn.at, nextAt);
      }
      return [num, { entries, next }] as const;
    }),
  );
  interface Summary {
    output: State | null;
    scan: FlowScan;
  }
  const summaries = new Map<string, Summary>();
  const work = { steps: 0, summaries: 0, hits: 0 };
  function emptyScan(): FlowScan {
    return {
      targets: [],
      variableTarget: false,
      calls: [],
      unresolvedCall: false,
      roomEvidence: false,
    };
  }
  function scan(logic: number, room?: number, main = false): FlowScan {
    let result = emptyScan();
    let targets = new Set<string>();
    let calls = new Set<number>();
    function merge(saved: FlowScan): void {
      result.variableTarget ||= saved.variableTarget;
      result.unresolvedCall ||= saved.unresolvedCall;
      result.roomEvidence ||= saved.roomEvidence;
      for (const call of saved.calls) calls.add(call);
      for (const target of saved.targets) {
        const id = `${target.to}:${target.edge ?? ""}`;
        if (!targets.has(id)) {
          targets.add(id);
          result.targets.push(target);
        }
      }
    }
    function runBody(
      num: number,
      input: State,
      stack: ReadonlySet<number>,
      inherited?: Side,
    ): State | null {
      if (stack.has(num) || !instructions.has(num)) {
        result.unresolvedCall = true;
        const output = new Map(input);
        clear(output);
        return output;
      }
      if (opaque.has(num)) {
        const output = new Map(input);
        const visited = new Set<number>();
        const queue = [num];
        while (queue.length) {
          const current = queue.pop()!;
          if (visited.has(current)) continue;
          visited.add(current);
          for (const insn of instructions.get(current)!) {
            result.roomEvidence ||= metadata.get(current)!.entries.get(insn.at)!.evidence;
            if (insn.name === "call") {
              calls.add(insn.args![0]!);
              queue.push(insn.args![0]!);
            } else if (["lindirectn", "lindirectv"].includes(insn.name ?? "")) clear(output);
            else
              for (const pos of VAR_WRITES[insn.name ?? ""] ?? [])
                if (relevant.has(insn.args![pos]!)) output.set(insn.args![pos]!, UNKNOWN);
          }
        }
        return output;
      }
      const vars = dependencies.get(num)!;
      const joined = new Map([...vars].map((v) => [v, input.get(v) ?? UNKNOWN]));
      const restore = (saved: State | null): State | null => {
        if (!saved) return null;
        const restored = new Map(input);
        for (const variable of vars) restored.set(variable, saved.get(variable) ?? UNKNOWN);
        return restored;
      };
      const insns = instructions.get(num)!;
      const { entries, next } = metadata.get(num)!;
      const states = new Map<number, State>();
      const queue: number[] = [];
      const pending = new Set<number>();
      let output: State | null = null;
      const path = new Set([...stack, num]);
      const enqueue = (at: number, state: State | null): void => {
        if (!state) return;
        at = next.get(at) ?? at;
        const old = states.get(at);
        if (!old) {
          states.set(at, new Map(state));
          queue.push(at);
          pending.add(at);
        } else if (join(old, state) && !pending.has(at)) {
          queue.push(at);
          pending.add(at);
        }
      };
      if (insns[0]) enqueue(insns[0].at, joined);
      // Each instruction state grows monotonically: one admission, at most
      // MAX_CONSTANTS new numbers per dependency, one unknown bit, then
      // widening. This bound follows the lattice and this LOGIC's size.
      const limit = (entries.size + 1) * (1 + vars.size * (MAX_CONSTANTS + 2));
      let processed = 0;
      while (queue.length) {
        if (++processed > limit) {
          result.variableTarget = true;
          result.unresolvedCall = true;
          const output = new Map(input);
          clear(output);
          return output;
        }
        const at = queue.shift()!;
        pending.delete(at);
        work.steps++;
        const entry = entries.get(at);
        if (!entry) continue;
        const { insn } = entry;
        const entryState = states.get(at)!;
        if (insn.kind === "return") {
          if (output) join(output, entryState);
          else output = new Map(entryState);
          continue;
        }
        if (insn.kind === "goto") {
          enqueue(insn.target, entryState);
          continue;
        }
        if (insn.kind === "if") {
          enqueue(insn.end, branch(entryState, entry.guards, true));
          enqueue(insn.target, branch(entryState, entry.guards, false));
          continue;
        }
        const state = new Map(entryState);
        const name = insn.name;
        const args = insn.args ?? [];
        result.roomEvidence ||= entry.evidence;
        const side = entry.side ?? inherited;
        if (name === "new.room" || name === "new.room.v") {
          const value = name === "new.room" ? literal(args[0]!) : (state.get(args[0]!) ?? UNKNOWN);
          if (name === "new.room.v") result.variableTarget ||= value.unknown;
          for (const to of value.numbers) {
            const id = `${to}:${side ?? ""}`;
            if (!targets.has(id)) {
              targets.add(id);
              result.targets.push(side ? { to, edge: side } : { to });
            }
          }
          continue;
        }
        if (name === "assignn" && relevant.has(args[0]!)) state.set(args[0]!, literal(args[1]!));
        else if (name === "assignv" && relevant.has(args[0]!))
          state.set(args[0]!, state.get(args[1]!) ?? UNKNOWN);
        else if (name === "call" || name === "call.v") {
          const value = name === "call" ? literal(args[0]!) : (state.get(args[0]!) ?? UNKNOWN);
          let returned: State | null = null;
          if (value.unknown) {
            result.unresolvedCall = true;
            returned = new Map(state);
            clear(returned);
          }
          for (const callee of value.numbers) {
            calls.add(callee);
            const answer = run(callee, state, path, side);
            if (answer) {
              if (returned) join(returned, answer);
              else returned = new Map(answer);
            }
          }
          if (returned) enqueue(insn.end, returned);
          continue;
        } else if (name === "lindirectn" || name === "lindirectv") clear(state);
        else
          for (const pos of VAR_WRITES[name ?? ""] ?? [])
            if (relevant.has(args[pos]!)) state.set(args[pos]!, UNKNOWN);
        enqueue(insn.end, state);
      }
      return restore(output);
    }
    function run(
      num: number,
      input: State,
      stack: ReadonlySet<number>,
      inherited?: Side,
    ): State | null {
      const vars = dependencies.get(num) ?? relevant;
      const projected = [...vars]
        .sort((a, b) => a - b)
        .map((v) => [v, input.get(v) ?? UNKNOWN] as const);
      const key = JSON.stringify([num, inherited, projected]);
      const cached = summaries.get(key);
      // A summary is reusable only when none of its calls meets an active
      // ancestor. Recursive entries keep the existing conservative clobber.
      if (cached && !stack.has(num) && !cached.scan.calls.some((callee) => stack.has(callee))) {
        work.hits++;
        merge(cached.scan);
        if (!cached.output) return null;
        const output = new Map(input);
        for (const variable of vars) output.set(variable, cached.output.get(variable) ?? UNKNOWN);
        return output;
      }
      const parent = { result, targets, calls };
      result = emptyScan();
      targets = new Set();
      calls = new Set();
      const output = runBody(num, input, stack, inherited);
      result.calls = [...calls];
      const summary = { output, scan: result };
      result = parent.result;
      targets = parent.targets;
      calls = parent.calls;
      merge(summary.scan);
      if (!stack.has(num) && !summary.scan.calls.includes(num)) {
        summaries.set(key, summary);
        work.summaries++;
      }
      return output;
    }
    const initial: State = new Map(
      [...globals]
        .filter(([variable, value]) => relevant.has(variable) && !value.unknown)
        .map(([variable, value]) => [variable, { numbers: value.numbers, unknown: true }] as const),
    );
    // A variable assigned in this invocation gets its destinations from that
    // control flow. Other LOGICs supply persisted candidates only when this
    // call tree leaves the variable untouched.
    const reachable = new Set<number>();
    const queue = [main ? 0 : logic];
    while (queue.length) {
      const num = queue.pop()!;
      if (reachable.has(num)) continue;
      reachable.add(num);
      for (const insn of instructions.get(num) ?? []) {
        for (const pos of VAR_WRITES[insn.name ?? ""] ?? []) initial.delete(insn.args?.[pos] ?? -1);
        if (insn.name === "call") queue.push(insn.args![0]!);
        else if (insn.name === "call.v") {
          if (insn.args?.[0] === 0 && room !== undefined) queue.push(room);
          else for (const callee of globals.get(insn.args![0]!)?.numbers ?? []) queue.push(callee);
        }
      }
    }
    if (room !== undefined) initial.set(0, literal(room));
    if (main && instructions.has(0)) run(0, initial, new Set());
    else run(logic, initial, new Set());
    result.calls = [...calls].sort((a, b) => a - b);
    return result;
  }
  return { scan, instructions, work };
}
