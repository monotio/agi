import type { ProgressTarget } from "../project/progressTarget.ts";

type WriterStorage = Pick<Storage, "getItem" | "setItem">;
export interface ProgressWriter {
  generation: number;
  owner: string;
}

export function progressWriterKey(locator: string): string {
  return `monotio_agi.writer.${locator}`;
}

function readProgressWriter(
  storage: Pick<Storage, "getItem">,
  locator: string,
): ProgressWriter | null {
  const raw = storage.getItem(progressWriterKey(locator));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<ProgressWriter> | null;
  if (
    !value ||
    !Number.isSafeInteger(value.generation) ||
    value.generation! < 1 ||
    typeof value.owner !== "string"
  )
    throw new Error("The game's play owner could not be read.");
  return { generation: value.generation!, owner: value.owner };
}

/** Called inside the same publication lock as checkpoints and slot writes. */
export function claimProgressWriter(
  storage: WriterStorage,
  target: ProgressTarget,
  owner: string,
): ProgressWriter {
  const previous = readProgressWriter(storage, target.locator);
  const writer = { generation: (previous?.generation ?? 0) + 1, owner };
  if (!Number.isSafeInteger(writer.generation))
    throw new Error("The game's play owner needs a fresh storage entry.");
  storage.setItem(progressWriterKey(target.locator), JSON.stringify(writer));
  return writer;
}

/** Every write rechecks the physical fence, including a late pagehide checkpoint. */
export function progressWriterMatches(
  storage: Pick<Storage, "getItem">,
  locator: string,
  generation: number | undefined,
): boolean {
  const writer = readProgressWriter(storage, locator);
  return writer === null ? true : generation === writer.generation;
}
