/**
 * Shared contracts for the AGI engine.
 * Generated games target AGI 2.936; imported games select their version profile.
 * Independent implementation of Peter Kelly’s agi-re behavioral specification.
 */

/** Logical picture surface dimensions (full-EGA target). */
export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 168;

/** The two logical channels of the picture surface. One byte per cell, low nibble significant. */
export interface PictureSurface {
  /** Visual color per cell, 0..15. Row-major, 160x168. */
  readonly visual: Uint8Array;
  /** Priority/control value per cell, 0..15. Row-major, 160x168. */
  readonly priority: Uint8Array;
  /** Reset every cell: visual 15, priority 4 (prepare semantics). */
  reset(): void;
}

export function createPictureSurface(): PictureSurface {
  const visual = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const priority = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const surface: PictureSurface = {
    visual,
    priority,
    reset(): void {
      visual.fill(15);
      priority.fill(4);
    },
  };
  surface.reset();
  return surface;
}

/** Resource families, in split and combined directory order. */
export type ResourceKind = "logic" | "picture" | "view" | "sound";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["logic", "picture", "view", "sound"];

/**
 * In-memory view of an AGI v2 split or v3 combined container.
 * Browser-compatible: no filesystem access. Adapters persist/restore the byte maps.
 */
export interface GameContainer {
  /**
   * Expanded payload of a resource, or null if absent.
   * For the v2 uncompressed profile the stored payload IS the expanded payload.
   */
  getResource(kind: ResourceKind, num: number): Uint8Array | null;

  /**
   * Add or replace a resource transactionally, retaining current indexed records
   * and resource IDs while reclaiming superseded volume data.
   */
  putResource(kind: ResourceKind, num: number, payload: Uint8Array): void;

  /** Replace auxiliary game metadata with an owned copy for live remix and export. */
  putFile(name: "WORDS.TOK" | "OBJECT" | "TESTS.JSON", payload: Uint8Array): void;

  /** Raw container files, e.g. "LOGDIR" -> bytes, "VOL.0" -> bytes. For persistence. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}
