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
 * Resolve variables only in the room's own LOGIC, in one forward pass. Branch
 * joins retain constants only when all incoming paths agree. Calls, scan-start
 * changes and indirect writes clear bindings; backward jumps disable inference.
 * Helpers contribute literal resource references without binding analysis.
 * LOGIC 0 already runs where the player is and contributes no room association.
 */
export async function createRoomResourceUses(
  files: ReadonlyMap<string, Uint8Array>,
  profile: AgiProfile,
  work?: { instructions: number },
): Promise<(key: string) => readonly string[]> {
  const [{ decodeLogicInsns }, { resourceReferenceOperand }, { VAR_WRITES }] = await Promise.all([
    import("../../../src/logic/disassembler.ts"),
    import("../../../src/logic/commandReference.ts"),
    import("../../../src/agent/roomFlow.ts"),
  ]);
  const container = openContainer(files, { profile });
  const decoded = new Map<
    number,
    {
      instructions: ReturnType<typeof decodeLogicInsns>;
      uses: string[];
      calls: number[];
    } | null
  >();
  function readLogic(num: number) {
    if (num === 0) return null;
    if (decoded.has(num)) return decoded.get(num)!;
    try {
      const bytes = container.getResource("logic", num);
      if (bytes) {
        const insns = decodeLogicInsns(bytes, { profile });
        const uses = new Set<string>();
        const calls = new Set<number>();
        for (const instruction of insns) {
          if (work) work.instructions++;
          const name = instruction.name ?? "";
          const args = instruction.args ?? [];
          const role = resourceReferenceOperand(name, profile);
          if (role && !role.variable && (role.kind === "picture" || role.kind === "view"))
            uses.add(`${role.kind}:${args[role.operand]}`);
          if (name === "call") calls.add(args[0]!);
        }
        const result = { instructions: insns, uses: [...uses], calls: [...calls] };
        decoded.set(num, result);
        return result;
      }
    } catch {
      // Unreadable LOGIC cannot establish a resource association.
    }
    decoded.set(num, null);
    return null;
  }
  type State = Map<number, number>;
  function scanRoom(room: number): readonly string[] {
    const insns = readLogic(room)?.instructions ?? [];
    const incoming = new Map<number, State>();
    if (insns[0]) incoming.set(insns[0].at, new Map([[0, room]]));
    const uses = new Set<string>();
    const variableUses = new Set<string>();
    const calls = new Set<number>();
    const variableCalls = new Set<number>();
    let infer = true;
    function forward(at: number, state: State): void {
      const previous = incoming.get(at);
      if (!previous) incoming.set(at, new Map(state));
      else
        for (const [variable, value] of previous)
          if (state.get(variable) !== value) previous.delete(variable);
    }
    // decodeLogicInsns returns byte-stream order. Each instruction is visited
    // once; a loop never schedules a second visit or retains variable guesses.
    for (const instruction of insns) {
      if (work) work.instructions++;
      if (
        (instruction.kind === "if" || instruction.kind === "goto") &&
        instruction.target <= instruction.at
      ) {
        infer = false;
        variableUses.clear();
        variableCalls.clear();
      }
      const state = incoming.get(instruction.at);
      if (!state || instruction.kind === "return") continue;
      if (instruction.kind === "if" || instruction.kind === "goto") {
        if (instruction.target > instruction.at) forward(instruction.target, state);
        if (instruction.kind === "if") forward(instruction.end, state);
        continue;
      }
      const name = instruction.name ?? "";
      const args = instruction.args ?? [];
      const role = resourceReferenceOperand(name, profile);
      if (role && (role.kind === "picture" || role.kind === "view")) {
        if (!role.variable) uses.add(`${role.kind}:${args[role.operand]}`);
        else if (infer) {
          const value = state.get(args[role.operand]!);
          if (value !== undefined) variableUses.add(`${role.kind}:${value}`);
        }
      }
      if (name === "new.room" || name === "new.room.v") continue;
      if (name === "call") calls.add(args[0]!);
      else if (name === "call.v" && infer) {
        const target = state.get(args[0]!);
        if (target !== undefined) variableCalls.add(target);
      }
      if (
        [
          "call",
          "call.v",
          "set.scan.start",
          "reset.scan.start",
          "lindirectn",
          "lindirectv",
        ].includes(name) ||
        instruction.kind === "data"
      )
        state.clear();
      else if (name === "assignn") state.set(args[0]!, args[1]!);
      else if (name === "assignv") {
        const value = state.get(args[1]!);
        if (value === undefined) state.delete(args[0]!);
        else state.set(args[0]!, value);
      } else for (const operand of VAR_WRITES[name] ?? []) state.delete(args[operand]!);
      forward(instruction.end, state);
    }
    for (const use of variableUses) uses.add(use);
    const visited = new Set([0, room]);
    const pending = [...calls, ...variableCalls];
    while (pending.length) {
      const num = pending.pop()!;
      if (visited.has(num)) continue;
      visited.add(num);
      const helper = readLogic(num);
      if (!helper) continue;
      for (const use of helper.uses) uses.add(use);
      pending.push(...helper.calls);
    }
    return [...uses];
  }
  const cache = new Map<number, readonly string[]>();
  return (key) => {
    const room = Number(key.slice(6));
    let uses = cache.get(room);
    if (!uses) {
      uses = scanRoom(room);
      cache.set(room, uses);
    }
    return uses;
  };
}
