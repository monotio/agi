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
