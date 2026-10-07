/**
 * The shared `sound:N` source boundary: the versioned `agi.sound-document`
 * envelope beside the legacy SoundTrackInput[] JSON body. A sound document's
 * source text parses to one of two shapes — a track-array the project codec
 * validates with its own strict reader, or the bounded envelope the document
 * module reads losslessly — and this module is the one place that names and
 * verifies the envelope form so the project documents and the agent session
 * never each invent their own reading.
 *
 * The envelope pins its interpreter profile identity; the adapter hands its
 * caller's selected profile here, and a pinned profile naming anything else
 * is a refusal, never a relabeling or a rebuild under a different family.
 * Compiled bytes are exactly `SoundDocument.encode()`: retained event ids,
 * the allocator cursor, raw records and opaque classification ride inside
 * the envelope untouched. A claim is only adopted beside the native SOUND
 * resource it reproduces byte for byte — native bytes stay authoritative.
 */
import {
  readSoundDocumentEnvelope,
  type SoundDocument,
  type SoundDocumentEnvelope,
} from "./document.ts";
import type { SoundTrackInput } from "./build.ts";
import type { ProfileId } from "../runtime/profile.ts";

/**
 * The source forms a `sound:N` document or stored `sources.sounds` entry
 * admits: the legacy SoundTrackInput[] body, or the tagged
 * `agi.sound-document` version-1 envelope.
 */
export type SoundSourceBody = SoundTrackInput[] | SoundDocumentEnvelope;

/**
 * Whether a parsed sound source body claims the tagged SoundDocument
 * envelope form rather than legacy tracks. This is only a dispatch shape —
 * every non-array object claims it — and promises nothing about validity:
 * the envelope reader judges the claim and names its own malformed input.
 */
export function isSoundDocumentEnvelopeClaim(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open a tagged envelope source under the project's selected profile. The
 * strict envelope reader validates format, version, fields, payload, ids and
 * classification before the pinned profile is compared — a mismatch refuses
 * with the envelope's stored identity intact.
 */
function openSoundDocumentSource(value: unknown, profileId: ProfileId): SoundDocument {
  const document = readSoundDocumentEnvelope(value);
  if (document.profileId !== profileId) {
    throw new Error(
      `The sound document is pinned to profile '${document.profileId}', ` +
        `but this project selects '${profileId}'.`,
    );
  }
  return document;
}

/**
 * Compile a tagged envelope source to its exact native payload — the same
 * buffer `SoundDocument.encode()` returns, opaque bytes included.
 */
export function compileSoundDocumentSource(value: unknown, profileId: ProfileId): Uint8Array {
  return openSoundDocumentSource(value, profileId).encode();
}

/**
 * Validate an imported envelope claim for storage and return a fully owned,
 * JSON-safe `SoundDocumentEnvelope`: the same ids, allocator cursor, payload
 * and pinned profile, sharing no mutable state with the input. The claim is
 * refused when the claimed resource has no native bytes, or when the
 * document payload differs from them — the claim is compared to the stored
 * resource, never used to reserialize it.
 */
export function readSoundDocumentSource(
  value: unknown,
  profileId: ProfileId,
  native: Uint8Array | null,
): SoundDocumentEnvelope {
  const document = openSoundDocumentSource(value, profileId);
  if (native === null)
    throw new Error("The sound document source claims a missing native SOUND resource.");
  const encoded = document.encode();
  if (encoded.length !== native.length || !encoded.every((byte, index) => byte === native[index]))
    throw new Error("The sound document source payload does not reproduce the native SOUND bytes.");
  return document.serialize();
}
