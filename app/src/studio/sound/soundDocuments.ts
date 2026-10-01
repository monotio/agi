/**
 * Sound Studio's document boundary: how a `sound:N` project document opens as
 * a strict SoundDocument and writes back. The draft holds one of three honest
 * forms — the tagged `agi.sound-document` envelope claim, a legacy
 * SoundTrackInput[] claim, or retained native bytes — and every form opens
 * through the document model's own readers, so raw records, opaque payloads
 * and event-id cursors survive untouched.
 */
import type { AuthoringState } from "../../../../src/authoring/authoringState.ts";
import { resourceCacheHint } from "../../../../src/authoring/authoringState.ts";
import { readMusicDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { buildSound, type SoundTrackInput } from "../../../../src/sound/build.ts";
import {
  importSoundDocument,
  readSoundDocumentEnvelope,
  type SoundDocument,
} from "../../../../src/sound/document.ts";
import { isSoundDocumentEnvelopeClaim } from "../../../../src/sound/source.ts";

/** The native SOUND resource bound; enforced before any async import work. */
export const SOUND_MAX_BYTES = 65_535;
/** A new cue's authored tempo until the inspector edits it. */
const SOUND_DEFAULT_TEMPO = 120;

const SOUND_KEY = /^sound:(0|[1-9]\d{0,2})$/;

export type SoundSourceKind = "envelope" | "tracks" | "bytes";

export interface OpenedSound {
  readonly document: SoundDocument;
  readonly source: SoundSourceKind;
}

function parseSoundJson(text: string, key: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The '${key}' document is not readable JSON.`, { cause: error });
  }
}

/**
 * Open one `sound:N` document's content as a SoundDocument under the project
 * profile. A text claim parses as the tagged envelope or a legacy track
 * array — tracks compile through the same `buildSound` the project codec
 * uses, then import, so what the editor shows is exactly the native bytes
 * the claim produces. Bytes open as a native import, which keeps opaque
 * families opaque.
 */
export function openSoundContent(
  key: string,
  content: string | Uint8Array,
  profileId: ProfileId,
): OpenedSound {
  if (content instanceof Uint8Array) {
    return { document: importSoundDocument(content, { profileId }), source: "bytes" };
  }
  const body = parseSoundJson(content, key);
  if (isSoundDocumentEnvelopeClaim(body)) {
    const document = readSoundDocumentEnvelope(body);
    if (document.profileId !== profileId) {
      throw new Error(
        `The '${key}' document is pinned to profile '${document.profileId}', ` +
          `but this project selects '${profileId}'.`,
      );
    }
    return { document, source: "envelope" };
  }
  if (!Array.isArray(body)) {
    throw new Error(`The '${key}' document is neither a sound document envelope nor a track list.`);
  }
  const tracks = body as SoundTrackInput[];
  return { document: importSoundDocument(buildSound(tracks), { profileId }), source: "tracks" };
}

/**
 * Raise a document's allocator cursor to a remembered floor so an undo or a
 * reopened draft can never reissue an event id this workspace already used.
 */
export function withEventCursorFloor(document: SoundDocument, floor: number): SoundDocument {
  const envelope = document.serialize();
  if (envelope.nextEventId >= floor) return document;
  return readSoundDocumentEnvelope({ ...envelope, nextEventId: floor });
}

/** `sound:N` for a resource number. */
export function soundKey(num: number): string {
  return `sound:${num}`;
}

/** The resource number of a `sound:N` key, or null for other documents. */
function soundKeyNum(key: string): number | null {
  const match = SOUND_KEY.exec(key);
  if (match === null || Number(match[1]) > 255) return null;
  return Number(match[1]);
}

/** Every `sound:N` key present in a document key list, in resource order. */
export function listSoundNums(keys: readonly string[]): number[] {
  return keys
    .map((key) => soundKeyNum(key))
    .filter((num): num is number => num !== null)
    .sort((a, b) => a - b);
}

/** The lowest SOUND number no document claims, or null when all 256 exist. */
export function firstFreeSoundNum(keys: readonly string[]): number | null {
  const used = new Set(listSoundNums(keys));
  for (let num = 0; num <= 255; num++) {
    if (!used.has(num)) return num;
  }
  return null;
}

export type MusicMap = NonNullable<AuthoringState["music"]>;

/** Read a `music` document; absent or empty text means no entries. */
export function readMusicMap(content: string | Uint8Array | null | undefined): MusicMap {
  if (typeof content !== "string" || !content.trim()) return {};
  return readMusicDocument(content);
}

/** The canonical `music` document text: entries sorted by sound number. */
export function writeMusicMap(map: MusicMap): string {
  const sorted: MusicMap = {};
  for (const num of Object.keys(map).sort((a, b) => Number(a) - Number(b))) {
    sorted[num] = map[num]!;
  }
  return JSON.stringify(sorted);
}

/**
 * The `music` map entry a kept sound edit writes: the new payload's revision
 * hint beside the tempo this cue already authored (or the default for a fresh
 * cue). An entry for a sound that no longer exists is dropped.
 */
export function musicMapForSound(
  map: MusicMap,
  num: number,
  payload: Uint8Array,
  tempo: number | null,
): MusicMap {
  const next: MusicMap = { ...map };
  next[String(num)] = {
    revision: resourceCacheHint(payload),
    tempo: tempo ?? SOUND_DEFAULT_TEMPO,
  };
  return next;
}

/** The tempo a sound's music entry names, or null when none matches. */
export function tempoForSound(map: MusicMap, num: number): number | null {
  return map[String(num)]?.tempo ?? null;
}
