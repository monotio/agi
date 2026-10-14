import { openContainer } from "../../../src/container/container.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { Engine } from "../../../src/runtime/engine.ts";

/**
 * Whether two game images differ in a resource the engine's current room has
 * in use. Such a change shows only after the room's entry code runs again; a
 * change to anything else takes effect when the game next uses it.
 */
export function roomResourcesChanged(
  engine: Engine,
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>,
): boolean {
  const options = { profile: engine.profile };
  const old = openContainer(before, options);
  const next = openContainer(after, options);
  const inUse = engine.roomResources();
  return (["logic", "picture", "view"] as const).some((kind) =>
    inUse[kind].some((num) => {
      const a = old.getResource(kind, num);
      const b = next.getResource(kind, num);
      return a === null || b === null
        ? a !== b
        : a.length !== b.length || a.some((byte, index) => byte !== b[index]);
    }),
  );
}

/** Known rooms affected by an applied change; shared LOGIC dependencies may carry art uses. */
export function roomsUsingResources(
  resources: readonly string[],
  rooms: readonly number[],
  currentRoom: number,
  dependencies: (key: string) => readonly string[],
): number[] {
  const art = new Set(resources.filter((key) => /^(picture|view):\d+$/.test(key)));
  return [...new Set(rooms)].filter((room) => {
    if (room === currentRoom) return false;
    if (resources.includes(`logic:${room}`)) return true;
    if (art.size === 0) return false;
    const visited = new Set<string>();
    const pending = [`logic:${room}`];
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const use of dependencies(key)) {
        if (art.has(use)) return true;
        if (use.startsWith("logic:")) pending.push(use);
      }
    }
    return false;
  });
}

/**
 * Read committed bytecode with definite constants at each use: all paths into
 * an instruction must agree. Calls carry values into and back from their code;
 * runtime writes, indirect writes and unknown/recursive calls lose certainty.
 * LOGIC 0 is outside the room association: it already runs where the player is.
 */
export async function createRoomResourceUses(
  files: ReadonlyMap<string, Uint8Array>,
  profile: AgiProfile,
): Promise<(key: string) => readonly string[]> {
  const [{ inspectLogicResource }, { resourceReferenceOperand }, { VAR_WRITES }] =
    await Promise.all([
      import("../../../src/logic/disassembler.ts"),
      import("../../../src/logic/commandReference.ts"),
      import("../../../src/agent/roomFlow.ts"),
    ]);
  const container = openContainer(files, { profile });
  const instructions = new Map<number, ReturnType<typeof inspectLogicResource>["instructions"]>();
  for (let num = 1; num <= 255; num++) {
    try {
      const bytes = container.getResource("logic", num);
      if (bytes) instructions.set(num, inspectLogicResource(bytes, { profile }).instructions);
    } catch {
      // Unreadable callees cannot establish a constant.
    }
  }
  type State = Map<number, number>;
  function join(into: State, incoming: State): boolean {
    let changed = false;
    for (const [variable, value] of into) {
      if (incoming.get(variable) === value) continue;
      into.delete(variable);
      changed = true;
    }
    return changed;
  }
  function scan(
    logic: number,
    input: State,
    ancestors: ReadonlySet<number>,
  ): { state: State | null; uses: string[] } {
    const insns = instructions.get(logic);
    if (logic === 0 || ancestors.has(logic) || !insns?.length)
      return { state: new Map(), uses: [] };
    const path = new Set([...ancestors, logic]);
    const byOffset = new Map(insns.map((instruction) => [instruction.at, instruction]));
    const states = new Map<number, State>();
    const reads = new Map<number, string[]>();
    const queue: number[] = [];
    const pending = new Set<number>();
    let output: State | null = null;
    function enqueue(at: number, state: State): void {
      const previous = states.get(at);
      if (!previous) states.set(at, new Map(state));
      else if (!join(previous, state)) return;
      if (!pending.has(at)) {
        pending.add(at);
        queue.push(at);
      }
    }
    enqueue(insns[0]!.at, input);
    while (queue.length) {
      const at = queue.shift()!;
      pending.delete(at);
      const state = new Map(states.get(at)!);
      const instruction = byOffset.get(at);
      if (!instruction || instruction.kind === "return") {
        if (output === null) output = state;
        else join(output, state);
        continue;
      }
      if (instruction.kind === "if") {
        enqueue(instruction.target, state);
        enqueue(instruction.end, state);
        continue;
      }
      if (instruction.kind === "goto") {
        enqueue(instruction.target, state);
        continue;
      }
      const uses: string[] = [];
      reads.set(at, uses);
      const name = instruction.name ?? "";
      const args = instruction.args ?? [];
      const role = resourceReferenceOperand(name, profile);
      if (role && (role.kind === "picture" || role.kind === "view")) {
        const value = role.variable ? state.get(args[role.operand]!) : args[role.operand];
        if (value !== undefined) uses.push(`${role.kind}:${value}`);
      }
      if (name === "new.room" || name === "new.room.v") continue;
      if (name === "call" || name === "call.v") {
        const target = name === "call" ? args[0] : state.get(args[0]!);
        const called =
          target === undefined ? { state: new Map(), uses: [] } : scan(target, state, path);
        uses.push(...called.uses);
        if (called.state !== null) enqueue(instruction.end, called.state);
        continue;
      }
      if (name === "assignn") state.set(args[0]!, args[1]!);
      else if (name === "assignv") {
        const value = state.get(args[1]!);
        if (value === undefined) state.delete(args[0]!);
        else state.set(args[0]!, value);
      } else if (instruction.kind === "data" || name === "lindirectn" || name === "lindirectv")
        state.clear();
      else for (const operand of VAR_WRITES[name] ?? []) state.delete(args[operand]!);
      enqueue(instruction.end, state);
    }
    return { state: output, uses: [...new Set([...reads.values()].flat())] };
  }
  const cache = new Map<number, readonly string[]>();
  return (key) => {
    const room = Number(key.slice(6));
    let uses = cache.get(room);
    if (!uses) {
      uses = scan(room, new Map([[0, room]]), new Set()).uses;
      cache.set(room, uses);
    }
    return uses;
  };
}
