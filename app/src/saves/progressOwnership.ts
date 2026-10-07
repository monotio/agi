import type { ProgressTarget } from "../project/progressTarget.ts";
import { claimProgressWriter, progressWriterKey, progressWriterMatches } from "./progressWriter.ts";

interface OwnershipPorts {
  storage: Pick<Storage, "getItem" | "setItem">;
  owner: string;
  lock: <T>(locator: string, action: () => T) => Promise<T>;
  changed: (lost: boolean) => void;
}

/** The physical generation is checked again by every checkpoint and slot write. */
export function createProgressOwnership(ports: OwnershipPorts) {
  let target: ProgressTarget | null = null;
  let generation: number | undefined;
  let epoch = 0;
  let lastGeneration = 0;
  async function acquire(next: ProgressTarget): Promise<void> {
    const request = ++epoch;
    const previous = target;
    const previousGeneration = generation;
    target = next;
    generation = undefined;
    if (previous && previous.locator !== next.locator) {
      lastGeneration = 0;
      ports.changed(true);
      await ports.lock(previous.locator, () => {
        if (
          epoch === request &&
          previousGeneration !== undefined &&
          progressWriterMatches(ports.storage, previous.locator, previousGeneration)
        )
          claimProgressWriter(ports.storage, previous, ports.owner);
      });
    }
    await ports.lock(next.locator, () => {
      if (epoch !== request) return;
      generation = claimProgressWriter(ports.storage, next, ports.owner).generation;
      lastGeneration = generation;
      ports.changed(false);
    });
  }
  function observe(key: string | null): void {
    if (!target || key !== progressWriterKey(target.locator)) return;
    if (!progressWriterMatches(ports.storage, target.locator, generation)) {
      generation = undefined;
      ports.changed(true);
    }
  }
  return {
    acquire,
    observe,
    generation: () => generation,
    lastGeneration: () => lastGeneration,
    epoch: () => epoch,
    takeBack: async () => {
      if (target) await acquire(target);
    },
    close: () => {
      epoch++;
      target = null;
      generation = undefined;
    },
  };
}
