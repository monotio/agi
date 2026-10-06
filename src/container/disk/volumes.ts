import { sha256Hex } from "../../crypto.ts";

/**
 * Original releases whose combined directory references volumes absent from
 * the release itself, keyed by the directory file's SHA-256 so only that exact
 * edition gets the allowance. Both directories match the ScummVM detection
 * fingerprints for these releases; docs/testing.md records the evidence.
 */
const UNSHIPPED_VOLUMES: Record<string, readonly number[]> = {
  // King's Quest IV 2.0 (1988-07-27, 3.5"): pictures 150-151, views 198-199.
  "3ceb755dc98398f3369038d21528763c05aac926238681ad88efac74c60d4d2d": [6, 7],
  // Manhunter 2 3.02 (1989-07-26, 3.5"): sounds 215-216.
  f646929faac4b905c4ed9fe3d8661cb33c97e4ae3168c38fa097cf3e1dbd8948: [6],
};

/** Only these exact released directories may omit their unshipped volumes. */
export function unshippedDiskVolumes(directory: Uint8Array): readonly number[] {
  return UNSHIPPED_VOLUMES[sha256Hex(directory)] ?? [];
}
