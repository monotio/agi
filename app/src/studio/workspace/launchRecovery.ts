import type { AuthoringState } from "../../../../src/authoring/authoringState.ts";
import { readWorldLaunches, type WorldLaunches } from "../../../../src/authoring/launches.ts";

/** Keep the saved bytes available for repair while the rest of the world opens. */
export function inspectLaunches(world: AuthoringState["world"]): {
  launches: WorldLaunches;
  error: string;
} {
  try {
    return { launches: world.launches ? readWorldLaunches(world.launches) : {}, error: "" };
  } catch (cause) {
    return { launches: {}, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Remove transition-owned inputs from affected Launches, then validate the complete result. */
export function repairLaunches(world: AuthoringState["world"]): AuthoringState["world"] {
  const next = structuredClone(world);
  for (const room of Object.values(next.launches ?? {})) {
    for (const launch of room.entries) {
      if (launch.variables) {
        delete launch.variables["0"];
        delete launch.variables["2"];
      }
      if (launch.flags) delete launch.flags["5"];
    }
  }
  if (next.launches) next.launches = readWorldLaunches(next.launches);
  return next;
}
