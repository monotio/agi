import { openContainer } from "../../../src/container/container.ts";
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
