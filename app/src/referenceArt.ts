/**
 * Reference art: a picture the player supplies for the agent to encode into
 * native resources. References are project data — stored with the project
 * record, carried in the Project download and never in a Game export — each
 * stamped with the `GameIdentity` it was attached at so a commit against
 * moved bytes is refused rather than silently retargeted.
 *
 * Two kinds: a room reference is a composition the agent hand-encodes with
 * write_picture while looking at it; a character reference is one pose row
 * per facing, converted deterministically by src/view/characterSheet.ts into
 * a staged VIEW the player keeps or revises. The harness owns the sheet
 * manifest — poses, facings, cel size, ground line — and never infers it
 * from the pixels.
 */
import { type GameIdentity, gameIdentity } from "../../src/gameIdentity.ts";
import type { AgentToolImage } from "../../src/agent/tools.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import {
  convertCharacterSheet,
  type CharacterSheetSpec,
  type SheetBitmap,
  type SheetFacing,
} from "../../src/view/characterSheet.ts";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";

/** Uploaded file bytes; a pose sheet or room plate beyond this is refused. */
export const REFERENCE_BYTE_LIMIT = 8 * 1024 * 1024;
/** Decoded pixel budget — 4096x4096 or any shape totalling the same. */
export const REFERENCE_PIXEL_LIMIT = 16 * 1024 * 1024;
/** Stored references per project. */
export const REFERENCE_COUNT_LIMIT = 16;
/** Player-facing brief text. */
export const REFERENCE_BRIEF_LIMIT = 2000;

/** The presentation proportion a room reference is asked for (160x168 drawn double-wide). */
export const ROOM_REFERENCE_ASPECT = 320 / 168;

/** File extension for a stored reference's MIME type, for archive entries. */
export function mimeExtension(mime: string): string {
  return mime === "image/jpeg" ? "jpeg" : mime === "image/webp" ? "webp" : "png";
}

export interface ReferenceImage {
  /** The facing this pose row covers; undefined on a room reference. */
  readonly facing: SheetFacing | undefined;
  /** The upload's own bytes, base64 — sent to the model as-is. */
  readonly png: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

/** A converted character sheet waiting on the player's keep/revise call. */
export interface StagedView {
  /** The VIEW resource number it commits to on keep. */
  readonly num: number;
  /** Packed VIEW payload, base64 — `buildView(input)`. */
  readonly payload: string;
  /** The editable spec; kept in the session's `sources.views` on keep. */
  readonly input: BuildViewInput;
  /** Cel dimensions per loop for the preview's summary line. */
  readonly loops: readonly {
    facing: SheetFacing;
    cels: readonly { width: number; height: number }[];
  }[];
  readonly warnings: readonly string[];
  readonly substitutions: readonly string[];
}

export interface StoredReference {
  readonly id: string;
  readonly kind: "room" | "character";
  /** Room number, or the VIEW number a staged character commits to. */
  readonly target: number;
  readonly brief: string;
  readonly images: readonly ReferenceImage[];
  /** The game's identity when the reference was attached — staleness is judged on this. */
  readonly attachedAt: GameIdentity;
  /** The original attachment identity when a copy/import rebound this reference. */
  readonly origin?: GameIdentity | undefined;
  /** A copy/export verified this candidate was already stale; rebinding must not revive it. */
  readonly stale?: true | undefined;
  /** The declared sheet manifest, character references only. */
  readonly sheet?: { poses: number; celHeight: number; symmetric: boolean } | undefined;
  readonly staged?: StagedView | undefined;
}

/**
 * The decoded upload `decodeReferenceFile` produces (referenceDecode.ts —
 * the decoder is DOM-only; this module stays platform-free for the Node
 * typecheck and tests).
 */
export interface DecodedImage extends SheetBitmap {
  readonly mime: string;
  /** The upload's own file bytes — what the model receives. */
  readonly bytes: Uint8Array;
}

/** The upload's decoded bitmap as one stored image entry. */
export function referenceImage(decoded: DecodedImage, facing?: SheetFacing): ReferenceImage {
  return {
    facing,
    png: bytesToBase64(decoded.bytes),
    mime: decoded.mime,
    width: decoded.width,
    height: decoded.height,
  };
}

/**
 * Convert a character reference's pose rows into its staged VIEW. The spec
 * is the declared manifest — the stored reference carries it verbatim so the
 * preview shows exactly what will commit. Throws the converter's named
 * constraint on unusable input.
 */
export function stageCharacterView(
  id: string,
  target: number,
  brief: string,
  attachedAt: GameIdentity,
  sheets: { decoded: DecodedImage; facing: SheetFacing }[],
  spec: CharacterSheetSpec,
): StoredReference {
  const images: Partial<Record<SheetFacing, SheetBitmap>> = {};
  const entries: ReferenceImage[] = [];
  for (const { decoded, facing } of sheets) {
    images[facing] = decoded;
    entries.push(referenceImage(decoded, facing));
  }
  const converted = convertCharacterSheet(images, spec);
  return {
    id,
    kind: "character",
    target,
    brief,
    images: entries,
    attachedAt,
    sheet: {
      poses: spec.poses,
      celHeight: spec.celHeight ?? 32,
      symmetric: spec.symmetric === true,
    },
    staged: {
      num: target,
      payload: bytesToBase64(converted.view),
      input: plainViewInput(converted.input),
      loops: converted.loops,
      warnings: converted.warnings,
      substitutions: converted.substitutions,
    },
  };
}

/**
 * Cel pixels as plain arrays: the staged spec rides PROJECT.JSON, where a
 * Uint8Array would stringify into an unreadable object.
 */
function plainViewInput(input: BuildViewInput): BuildViewInput {
  return {
    ...input,
    loops: input.loops.map((loop) => ({
      ...loop,
      ...(loop.cels ? { cels: loop.cels.map((cel) => ({ ...cel, pixels: [...cel.pixels] })) } : {}),
    })),
  };
}

/** A room reference carries one image and no staged resource. */
export function roomReference(
  id: string,
  target: number,
  brief: string,
  attachedAt: GameIdentity,
  decoded: DecodedImage,
): StoredReference {
  return {
    id,
    kind: "room",
    target,
    brief,
    images: [referenceImage(decoded)],
    attachedAt,
  };
}

/** The reference as provider image blocks — the upload's own bytes per image. */
export function referenceAgentImages(reference: StoredReference): AgentToolImage[] {
  return reference.images.map((image) => {
    if (image.mime !== "image/png" && image.mime !== "image/jpeg" && image.mime !== "image/webp")
      throw new Error("References must be PNG, JPEG or WebP images.");
    return {
      png: base64ToBytes(image.png),
      mime: image.mime,
      caption:
        `Player-supplied reference for ` +
        (reference.kind === "room" ? `room ${reference.target}` : `view ${reference.target}`) +
        (image.facing !== undefined ? `, ${image.facing}-facing pose row` : "") +
        (reference.brief ? ` — ${reference.brief}` : "") +
        ". Encode it into native resources with the authoring tools; the reference decides look and composition, never walkable space or exits.",
    };
  });
}

/** Why a staged commit is refused, or null when the reference is current. */
export function stagedRefusal(reference: StoredReference, current: GameIdentity): string | null {
  if (reference.staged === undefined) return "Nothing is staged from this reference.";
  if (
    reference.stale === true ||
    reference.attachedAt.project !== current.project ||
    reference.attachedAt.revision !== current.revision
  )
    return "The game's resources changed since this reference was attached — attach a fresh copy to keep its staged view.";
  return null;
}

/**
 * Rebind candidates verified against source bytes to their destination. Export
 * supplies the pre-compaction identity; import can verify the revision carried
 * by the archive against its actual bytes. Once stale at a copy/export boundary,
 * a candidate stays stale even if compaction recreates its old revision.
 * Keep the first attachment identity as provenance through repeated transfers.
 */
export function rebindStagedReferences(
  references: StoredReference[] | undefined,
  destination: GameIdentity,
  source?: GameIdentity,
): StoredReference[] | undefined {
  if (!references?.length) return references;
  return references.map((reference) => {
    if (reference.staged === undefined || reference.stale === true) return reference;
    if (source !== undefined && stagedRefusal(reference, source) !== null)
      return { ...reference, stale: true };
    if (source === undefined && reference.attachedAt.revision !== destination.revision)
      return reference;
    if (
      reference.attachedAt.project === destination.project &&
      reference.attachedAt.revision === destination.revision
    )
      return reference;
    return {
      ...reference,
      attachedAt: destination,
      origin: reference.origin ?? reference.attachedAt,
    };
  });
}

/**
 * Normalize stored references on read: bounded count, bounded fields, and
 * only shapes this build understands — a corrupted entry is dropped, never
 * trusted. (Release contract: readers take normalized values.)
 */
export function normalizeReferences(raw: unknown): StoredReference[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredReference[] = [];
  for (const entry of raw.slice(0, REFERENCE_COUNT_LIMIT)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const attachedAt = gameIdentity(e["attachedAt"]);
    if (
      typeof e["id"] !== "string" ||
      (e["kind"] !== "room" && e["kind"] !== "character") ||
      typeof e["target"] !== "number" ||
      !Number.isInteger(e["target"]) ||
      typeof e["brief"] !== "string" ||
      e["brief"].length > REFERENCE_BRIEF_LIMIT ||
      !Array.isArray(e["images"]) ||
      attachedAt === null
    )
      continue;
    const origin = e["origin"] !== undefined ? gameIdentity(e["origin"]) : undefined;
    if (e["origin"] !== undefined && origin === null) continue;
    const images: ReferenceImage[] = [];
    for (const item of e["images"].slice(0, 4)) {
      if (!item || typeof item !== "object") continue;
      const i = item as Record<string, unknown>;
      if (
        typeof i["png"] !== "string" ||
        i["png"].length > REFERENCE_BYTE_LIMIT * 2 ||
        (i["mime"] !== "image/png" && i["mime"] !== "image/jpeg" && i["mime"] !== "image/webp") ||
        typeof i["width"] !== "number" ||
        typeof i["height"] !== "number" ||
        i["width"] * i["height"] > REFERENCE_PIXEL_LIMIT
      )
        continue;
      const facing = i["facing"];
      images.push({
        facing:
          facing === "right" || facing === "left" || facing === "down" || facing === "up"
            ? facing
            : undefined,
        png: i["png"],
        mime: i["mime"],
        width: i["width"],
        height: i["height"],
      });
    }
    if (images.length === 0) continue;
    const sheet = e["sheet"] as Record<string, unknown> | undefined;
    const staged = e["staged"] as Record<string, unknown> | undefined;
    out.push({
      id: e["id"],
      kind: e["kind"],
      target: e["target"],
      brief: e["brief"],
      images,
      attachedAt,
      ...(origin !== null && origin !== undefined ? { origin } : {}),
      ...(e["stale"] === true ? { stale: true } : {}),
      ...(sheet && Number.isInteger(sheet["poses"]) && Number.isInteger(sheet["celHeight"])
        ? {
            sheet: {
              poses: sheet["poses"] as number,
              celHeight: sheet["celHeight"] as number,
              symmetric: sheet["symmetric"] === true,
            },
          }
        : {}),
      ...(staged &&
      Number.isInteger(staged["num"]) &&
      typeof staged["payload"] === "string" &&
      staged["payload"].length <= 512 * 1024 &&
      Array.isArray(staged["warnings"]) &&
      Array.isArray(staged["substitutions"]) &&
      validViewInput(staged["input"])
        ? {
            staged: {
              num: staged["num"] as number,
              payload: staged["payload"],
              input: staged["input"] as BuildViewInput,
              loops: Array.isArray(staged["loops"]) ? (staged["loops"] as StagedView["loops"]) : [],
              warnings: (staged["warnings"] as unknown[]).filter(
                (w): w is string => typeof w === "string",
              ),
              substitutions: (staged["substitutions"] as unknown[]).filter(
                (w): w is string => typeof w === "string",
              ),
            },
          }
        : {}),
    });
  }
  return out;
}

/** The stored staged spec is only kept when it still compiles to a VIEW. */
function validViewInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || !Array.isArray((input as BuildViewInput).loops))
    return false;
  try {
    buildView(input as BuildViewInput);
    return true;
  } catch {
    return false;
  }
}
