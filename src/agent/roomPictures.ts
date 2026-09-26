/**
 * Room → picture, as far as the static exit scan can prove it. Kept beside
 * the room-graph model (roomMap.ts), which owns the scan itself.
 */
import type { StaticRoomScan } from "./roomMap.ts";

/** One picture a room's logic provably draws. */
export interface RoomPicture {
  readonly picture: number;
  /** The container holds this picture resource. */
  readonly exists: boolean;
  /** Other rooms whose own logic draws the same picture, ascending. */
  readonly sharedWith: readonly number[];
}

/** Which pictures a room draws, as far as the static scan can prove. */
export interface RoomPictureUse {
  /** A logic resource exists for the room. */
  readonly built: boolean;
  readonly pictures: readonly RoomPicture[];
  /**
   * A picture is chosen at runtime: an unbound draw, a shared logic whose v0
   * is its caller's, or no literal draw beside calls that may draw one.
   */
  readonly runtime: boolean;
}

/**
 * Room → picture from the scan's literal draws. The room number is never
 * assumed to be the picture number: only a draw.pic/overlay.pic whose
 * literal binding survives counts (v0 seeds as the room's own number, the
 * AGI convention the scan documents), and a shared logic claims nothing.
 */
export function roomPictureUse(
  room: number,
  input: {
    readonly scans: ReadonlyMap<number, StaticRoomScan>;
    readonly shared: ReadonlySet<number>;
    readonly pictures: ReadonlySet<number>;
  },
): RoomPictureUse {
  const scan = input.scans.get(room);
  if (!scan) return { built: false, pictures: [], runtime: false };
  if (input.shared.has(room)) return { built: true, pictures: [], runtime: true };
  const pictures = scan.pictures.map((picture) => {
    const sharedWith: number[] = [];
    for (const [other, otherScan] of input.scans) {
      if (other === room || input.shared.has(other)) continue;
      if (otherScan.pictures.includes(picture)) sharedWith.push(other);
    }
    sharedWith.sort((a, b) => a - b);
    return { picture, exists: input.pictures.has(picture), sharedWith };
  });
  const runtime =
    scan.unresolvedPicture ||
    (pictures.length === 0 && (scan.calls.length > 0 || scan.unresolvedCall));
  return { built: true, pictures, runtime };
}
