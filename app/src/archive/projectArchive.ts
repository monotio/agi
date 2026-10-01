import { hydrateImageAttachments } from "./projectImageArchive.ts";
import {
  readProjectHistory,
  writeProjectHistory,
  type PortableProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
} from "../../../src/authoring/projectRecoveryCodec.ts";
import type { PortableProjectRecovery } from "../../../src/authoring/projectRecoveryCodec.ts";
import { buildZip, type ZipFileInput } from "./zip.ts";
import { bytesToBase64 } from "../project/bytes.ts";
import { validateAuthoringState } from "../../../src/agent/authoringState.ts";
import { buildView, type BuildViewInput } from "../../../src/view/view.ts";
import { buildSound, type SoundTrackInput } from "../../../src/agent/soundBuilder.ts";
import {
  isSoundDocumentEnvelopeClaim,
  readSoundDocumentSource,
} from "../../../src/sound/source.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import { sha256Hex as sha256HexSync } from "../../../src/crypto.ts";
import type { CachedGameData } from "../project/gameTypes.ts";
import {
  mimeExtension,
  normalizeReferences,
  type StoredReference,
} from "../references/referenceArt.ts";
import type { GameProgress } from "../saves/gameProgress.ts";
import type { RoomMapSidecar } from "../../../src/agent/roomMap.ts";
import type { ProjectHistory } from "./historyArchive.ts";
import {
  gameEntries,
  PROJECT_SESSION_ID_PATTERN,
  validateTranscript,
} from "./projectArchiveShared.ts";
import type { BackupReport } from "./historyBackup.ts";

export { validateTranscript } from "./projectArchiveShared.ts";
export { continuationTranscript } from "./projectConversation.ts";

export interface ProjectContext {
  provider?: string | undefined;
  model?: string | undefined;
  sessionId?: string | undefined;
  transcript?: unknown[] | undefined;
  recoveryDraft?: PortableProjectRecovery | undefined;
  workspace?: PortableProjectWorkspace | undefined;
  projectHistory?: PortableProjectHistory | undefined;
  authoringState?: Record<string, unknown> | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
  references?: StoredReference[] | undefined;
}

/**
 * The archived game's own sound context: the interpreter profile the game
 * resolves to and its stored native SOUND bytes. An `agi.sound-document`
 * source claim is admitted only against both — the archived game, never the
 * claim, decides which profile applies, and the stored bytes stay
 * authoritative.
 */
export interface ProjectSoundContext {
  readonly profileId: ProfileId;
  readonly nativeSound: (num: number) => Uint8Array | null;
}

export function buildPublicGameZip(
  data: Pick<CachedGameData, "files" | "title" | "roomGeneration" | "library">,
): Uint8Array<ArrayBuffer> {
  return finishArchive(gameEntries(data));
}

/**
 * Archive a complete conversation; repeated image bytes become one ZIP attachment.
 * A project is for continuing the work elsewhere, so it also carries what a
 * published game must not reveal: the stored game tests are walkthroughs, and
 * the player's progress (save slots and latest autosave) is theirs alone.
 */
export async function buildProjectZip(
  offered: CachedGameData,
  progress?: GameProgress,
  map?: RoomMapSidecar,
  history?: ProjectHistory,
  backup?: BackupReport,
): Promise<Uint8Array<ArrayBuffer>> {
  return finishArchive(await collectProjectArchiveEntries(offered, progress, map, history, backup));
}

/** Validate private project entries on the first download action. */
export async function collectProjectArchiveEntries(
  offered: CachedGameData,
  progress?: GameProgress,
  map?: RoomMapSidecar,
  history?: ProjectHistory,
  backup?: BackupReport,
): Promise<ZipFileInput[]> {
  // The offer is captured before the module import suspends: the caller
  // keeps the original objects and may mutate them meanwhile, and a
  // completed archive must still be the game, the save slots, map, history
  // and backup report that were offered — not a mix observed at whichever
  // moment the module arrived. The clones are also what the produced
  // entries hold, so a native save buffer or sidecar offered here is
  // detached from the caller's own objects before any write. The writer
  // clones again on arrival, so its own capture contract holds however it
  // was reached.
  const captured = structuredClone(offered);
  const capturedProgress = progress === undefined ? undefined : structuredClone(progress);
  const capturedMap = map === undefined ? undefined : structuredClone(map);
  const capturedHistory = history === undefined ? undefined : structuredClone(history);
  const capturedBackup = backup === undefined ? undefined : structuredClone(backup);
  return import("./projectArchiveWriter.ts").then((writer) =>
    writer.collectProjectArchiveEntries(
      captured,
      capturedProgress,
      capturedMap,
      capturedHistory,
      capturedBackup,
    ),
  );
}

/**
 * The stored-ZIP cost of an entry list: entry count, expanded bytes and
 * packed STORED bytes (22-byte end record plus 30+name local and 46+name
 * central headers per entry, names measured as UTF-8 — the same arithmetic
 * `buildZip` output obeys). Throws the writer's own refusals when a bound
 * is exceeded, so an admission check fails exactly as a download would.
 */
function measureStoredArchive(entries: readonly ZipFileInput[]): {
  entries: number;
  expanded: number;
  packed: number;
} {
  if (entries.length > 1024) throw new Error("This project has more than 1024 archive entries.");
  const encoder = new TextEncoder();
  let expanded = 0;
  // Exact stored-ZIP size — a 30+name local header and 46+name central
  // header per entry plus the 22-byte end record, matching buildZip — is
  // checked before any output buffer exists, so an over-limit archive
  // refuses on arithmetic rather than after allocating its result.
  let packed = 22;
  for (const entry of entries) {
    const size =
      typeof entry.data === "string" ? encoder.encode(entry.data).length : entry.data.length;
    expanded += size;
    packed += size + 76 + 2 * encoder.encode(entry.name).length;
    if (size > 64 * 1024 * 1024 || expanded > 256 * 1024 * 1024)
      throw new Error(
        "This project exceeds the supported archive size. Choose Settings → This game → Export game… to keep its playable resources.",
      );
    if (packed > 128 * 1024 * 1024)
      throw new Error(
        "This project exceeds the 128 MB archive limit. Choose Settings → This game → Export game… to keep its playable resources.",
      );
  }
  return { entries: entries.length, expanded, packed };
}

function finishArchive(entries: ZipFileInput[]): Uint8Array<ArrayBuffer> {
  measureStoredArchive(entries);
  return buildZip(entries);
}

const MAX_PROJECT_DEPTH = 40;
const MAX_PROJECT_NODES = 25_000;
const MAX_RECONSTRUCTED_CONTENT_CHARS = 8 * 1024 * 1024;

/**
 * A version-2 archive may carry `agi.sound-document` sources whose `payload`
 * is one bounded byte array — the envelope codec's own 65,535-byte resource
 * bound per claim. Declared total for all claimed payloads: the sources list
 * already caps at 256 entries, so sound bytes together can never exceed
 * 256 × 65,535 — about 16 MB — without counting each byte as a project node.
 */
const MAX_SOUND_SOURCE_PAYLOAD_BYTES = 256 * 65_535;

export function readProjectContext(
  bytes: Uint8Array,
  entries: Map<string, Uint8Array>,
  root: string,
  soundContext?: ProjectSoundContext,
): ProjectContext {
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.format !== "monotio.agi.project" ||
    ![1, 2, 3, 4].includes(envelope.version)
  )
    throw new Error("This project version is not supported.");
  // The released version-1 envelope never carried creative data; a claim in
  // one refuses rather than silently dropping kept art or unfinished work.
  if (envelope.creative !== undefined || envelope.creativeWork !== undefined)
    throw new Error("This project version cannot carry creative data.");
  function knownFields(value: unknown, names: readonly string[]): void {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !names.includes(key))
    )
      throw new Error("Invalid or unknown project field.");
  }
  const hasAssistant = envelope.version === 1 || envelope.assistant !== undefined;
  if (envelope.version >= 2) {
    knownFields(envelope, [
      "format",
      "version",
      "assistant",
      "authoringState",
      "references",
      "recoveryDraft",
      "workspace",
      ...(envelope.version >= 3 ? ["projectHistory"] : []),
    ]);
    if (hasAssistant)
      knownFields(envelope.assistant, [
        "provider",
        "model",
        "sessionId",
        "conversation",
        "conversationHistory",
      ]);
  }
  const raw =
    envelope.version === 1
      ? envelope
      : {
          authoringState: envelope.authoringState === undefined ? {} : envelope.authoringState,
          references: envelope.references,
          ...(hasAssistant ? envelope.assistant : {}),
        };
  if (hasAssistant && raw.conversation?.formatVersion !== 1)
    throw new Error("This project conversation version is not supported.");
  if (
    hasAssistant &&
    (!["openai", "anthropic", "stub"].includes(raw.provider) || typeof raw.model !== "string")
  )
    throw new Error("Invalid project model metadata.");
  if (envelope.version >= 2) {
    if (hasAssistant) knownFields(raw.conversation, ["formatVersion", "messages"]);
    if (raw.references !== undefined && !Array.isArray(raw.references))
      throw new Error("Invalid project reference field.");
    if (
      raw.sessionId !== undefined &&
      (typeof raw.sessionId !== "string" || !PROJECT_SESSION_ID_PATTERN.test(raw.sessionId))
    )
      throw new Error("Invalid project session field.");
  }
  if (envelope.version < 3 && envelope.projectHistory !== undefined)
    throw new Error("This project version cannot carry edit History.");
  if (envelope.version === 4) {
    envelope.workspace = hydrateImageAttachments(envelope.workspace, entries, root);
    envelope.projectHistory = hydrateImageAttachments(envelope.projectHistory, entries, root);
  }
  const projectHistory =
    envelope.projectHistory === undefined
      ? undefined
      : writeProjectHistory(
          readProjectHistory(envelope.projectHistory, sha256HexSync),
          sha256HexSync,
        );
  const workspace =
    envelope.version >= 2 && envelope.workspace !== undefined
      ? writeProjectWorkspace(readProjectWorkspace(envelope.workspace))
      : undefined;
  const recovered =
    envelope.version >= 2 && envelope.recoveryDraft !== undefined
      ? readProjectRecovery(envelope.recoveryDraft)
      : undefined;
  const recoveryDraft =
    recovered === undefined ? undefined : writeProjectRecovery(recovered.base, recovered.recovery);
  // The `payload` of a claimed sound document source is one bounded byte
  // field, not fan-out: it is accounted by length against the declared
  // sound-source byte budget rather than inflating the generic node count
  // (a valid 65,535-byte document would otherwise refuse like a giant
  // conversation). Every element still faces the strict envelope reader in
  // the sources pass below, and only arrays actually sitting in a claimed
  // `payload` position get this accounting.
  const soundPayloads = new Set<unknown>();
  if (envelope.version >= 2) {
    const offeredState: unknown = raw.authoringState;
    const offeredSources =
      offeredState !== null && typeof offeredState === "object" && !Array.isArray(offeredState)
        ? (offeredState as Record<string, unknown>)["sources"]
        : undefined;
    const offeredSounds =
      offeredSources !== null &&
      typeof offeredSources === "object" &&
      !Array.isArray(offeredSources)
        ? (offeredSources as Record<string, unknown>)["sounds"]
        : undefined;
    if (Array.isArray(offeredSounds))
      for (const entry of offeredSounds) {
        if (!Array.isArray(entry) || !isSoundDocumentEnvelopeClaim(entry[1])) continue;
        const payload = (entry[1] as Record<string, unknown>)["payload"];
        if (Array.isArray(payload)) soundPayloads.add(payload);
      }
  }

  let nodeCount = 0;
  let reconstructedChars = 0;
  let soundPayloadBytes = 0;

  function scanRaw(value: unknown, depth = 0): void {
    if (depth > MAX_PROJECT_DEPTH) {
      throw new Error("Project conversation nesting is too deep.");
    }
    nodeCount++;
    if (nodeCount > MAX_PROJECT_NODES) {
      throw new Error("Project structure exceeds node count limit.");
    }
    if (typeof value === "string") {
      reconstructedChars += value.length;
      if (reconstructedChars > MAX_RECONSTRUCTED_CONTENT_CHARS) {
        throw new Error("Project reconstructed size exceeds content budget.");
      }
      return;
    }
    if (Array.isArray(value)) {
      if (soundPayloads.has(value)) {
        soundPayloadBytes += value.length;
        if (soundPayloadBytes > MAX_SOUND_SOURCE_PAYLOAD_BYTES) {
          throw new Error("Project sound document payloads exceed the archive's byte budget.");
        }
        return;
      }
      for (const item of value) {
        scanRaw(item, depth + 1);
      }
      return;
    }
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object["projectImage"] === "string") {
        const path = object["projectImage"];
        if (!/^IMAGES\/[a-f0-9]{64}\.(png|jpeg|webp)$/.test(path)) {
          throw new Error("Invalid project image reference.");
        }
        const image = entries.get(`${root}${path}`.toUpperCase());
        if (!image) {
          throw new Error("A project image attachment is missing.");
        }
        const estimatedBase64Chars = Math.ceil((image.length * 4) / 3) + 64;
        reconstructedChars += estimatedBase64Chars;
        if (reconstructedChars > MAX_RECONSTRUCTED_CONTENT_CHARS) {
          throw new Error("Project reconstructed size exceeds content budget.");
        }
        return;
      }
      for (const [key, child] of Object.entries(object)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) {
          throw new Error("Invalid project data key.");
        }
        reconstructedChars += key.length;
        scanRaw(child, depth + 1);
      }
    }
  }

  if (hasAssistant) scanRaw(raw.conversation.messages);
  scanRaw(raw.authoringState);
  if (raw.conversationHistory) {
    scanRaw(raw.conversationHistory);
  }
  if (raw.references !== undefined) scanRaw(raw.references);

  const attachmentCache = new Map<string, unknown>();

  function restore(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object["projectImage"] === "string") {
        const path = object["projectImage"];
        const isAnthropic = Boolean(object["anthropicSource"]);
        const cacheKey = `${isAnthropic ? "anthropic:" : "data:"}${path}`;
        const cached = attachmentCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const image = entries.get(`${root}${path}`.toUpperCase())!;
        let binary = "";
        for (const byte of image) binary += String.fromCharCode(byte);
        const mime = `image/${path.split(".").pop()}`;
        const encoded = isAnthropic
          ? { type: "base64", media_type: mime, data: btoa(binary) }
          : `data:${mime};base64,${btoa(binary)}`;
        attachmentCache.set(cacheKey, encoded);
        return encoded;
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, restore(child)]),
      );
    }
    return value;
  }
  const transcript = hasAssistant
    ? validateTranscript(restore(raw.conversation.messages), raw.provider)
    : undefined;
  const authoringState = restore(raw.authoringState);
  if (!authoringState || typeof authoringState !== "object" || Array.isArray(authoringState))
    throw new Error("Invalid project authoring state.");
  const snapshot = authoringState as Record<string, unknown>;
  if (snapshot["authoring"]) validateAuthoringState(snapshot["authoring"]);
  const sources = snapshot["sources"] as Record<string, unknown> | undefined;
  if (sources)
    for (const kind of ["logics", "pictures", "views", "sounds"]) {
      const entries = sources[kind];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length > 256)
        throw new Error("Invalid project authoring sources.");
      // A tagged sound document keeps editor identity (event ids, allocator
      // cursor), so its resource number must be unique across the sounds
      // sources — a second entry for the same SOUND would silently discard
      // one source at map hydration. Legacy track lists are untouched.
      const soundEntryNums =
        kind === "sounds" &&
        entries.some((entry) => Array.isArray(entry) && isSoundDocumentEnvelopeClaim(entry[1]))
          ? new Map<number, number>()
          : undefined;
      if (soundEntryNums !== undefined)
        for (const entry of entries) {
          if (!Array.isArray(entry)) continue;
          const num: unknown = entry[0];
          if (typeof num === "number" && Number.isInteger(num) && num >= 0 && num <= 255)
            soundEntryNums.set(num, (soundEntryNums.get(num) ?? 0) + 1);
        }
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !Number.isInteger(entry[0]) ||
          entry[0] < 0 ||
          entry[0] > 255
        )
          throw new Error("Invalid project source entry.");
        if (kind === "views") buildView(entry[1] as BuildViewInput);
        else if (kind === "sounds") {
          const body: unknown = entry[1];
          if (isSoundDocumentEnvelopeClaim(body)) {
            // A tagged `agi.sound-document` claim is admitted only by the
            // unreleased version-2 archive — the released version 1 format
            // never carried one — and only beside the game that can verify
            // it: the resolved profile, and the stored native SOUND bytes
            // the claim must reproduce exactly. The stored body becomes the
            // adapter's owned serialized envelope.
            if (envelope.version < 2)
              throw new Error("A sound document source needs a version 2 project archive.");
            if ((soundEntryNums?.get(entry[0]) ?? 0) > 1)
              throw new Error(`Duplicate sound document source for SOUND ${String(entry[0])}.`);
            if (soundContext === undefined)
              throw new Error(
                "The sound document source cannot be verified without the archived game.",
              );
            entry[1] = readSoundDocumentSource(
              body,
              soundContext.profileId,
              soundContext.nativeSound(entry[0]),
            );
          } else {
            buildSound(body as SoundTrackInput[]);
          }
        } else if (typeof entry[1] !== "string") throw new Error("Invalid project text source.");
      }
    }
  const history = restore(raw.conversationHistory ?? []);
  if (!Array.isArray(history) || history.length > 100)
    throw new Error("Invalid project conversation archive.");
  const conversationHistory = history.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string"
    )
      throw new Error("Invalid archived conversation metadata.");
    return {
      provider: item.provider,
      model: item.model,
      transcript: validateTranscript(item.transcript, item.provider),
    };
  });
  // Reference art: metadata without its image bytes; each image's bytes are a
  // REFERENCES/<id>.<index>.<ext> entry reattached by declared position.
  const references = Array.isArray(raw.references)
    ? (raw.references as Record<string, unknown>[]).map((reference) => {
        const images = Array.isArray(reference["images"]) ? reference["images"] : [];
        return {
          ...reference,
          images: images.map((item, index) => {
            const image = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const mime = typeof image["mime"] === "string" ? image["mime"] : "image/png";
            const name = `REFERENCES/${reference["id"]}.${index}.${mimeExtension(mime)}`;
            const data = entries.get(`${root}${name}`.toUpperCase());
            if (!data) throw new Error("A project reference image is missing.");
            return { ...image, png: bytesToBase64(data) };
          }),
        };
      })
    : undefined;
  return {
    ...(hasAssistant
      ? {
          provider: raw.provider,
          model: raw.model,
          ...(typeof raw.sessionId === "string" && PROJECT_SESSION_ID_PATTERN.test(raw.sessionId)
            ? { sessionId: raw.sessionId }
            : {}),
          transcript,
          conversationHistory,
        }
      : {}),
    authoringState: authoringState as Record<string, unknown>,
    ...(recoveryDraft !== undefined ? { recoveryDraft } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(projectHistory !== undefined ? { projectHistory } : {}),
    ...(references !== undefined ? { references: normalizeReferences(references) } : {}),
  };
}
