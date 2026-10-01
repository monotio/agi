/**
 * Private project-archive preparation: the exact entry list a project
 * download writes. The file a player opens on Home is never this one —
 * `projectArchive.ts` holds the synchronous readers and the public writer,
 * and loads this module only when an action (a project export, a creative
 * publication's prospective admission) asks for the full entry list.
 */
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
} from "../../../src/authoring/projectRecoveryCodec.ts";
import type { ZipFileInput } from "./zip.ts";
import { sha256Hex } from "../project/crypto.ts";
import { base64ToBytes } from "../project/bytes.ts";
import { gameRevision } from "../project/gameMetadata.ts";
import { openContainer } from "../../../src/container/container.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";
import {
  isSoundDocumentEnvelopeClaim,
  readSoundDocumentSource,
} from "../../../src/sound/source.ts";
import {
  creativeProjectBlobHashes,
  readCreativeProjectManifest,
  writeCreativeProjectManifest,
} from "../../../src/creative/project.ts";
import { readCreativeWork, writeCreativeWork } from "../../../src/creative/workArchive.ts";
import {
  compareCodePoints,
  type BlobHash,
  type RegisteredBlob,
} from "../../../src/creative/catalog.ts";
import { mimeExtension, rebindStagedReferences } from "../references/referenceArt.ts";
import { progressEntries, type GameProgress } from "../saves/gameProgress.ts";
import { mapArchiveData } from "../world/roomMapStore.ts";
import type { RoomMapSidecar } from "../../../src/agent/roomMap.ts";
import { historyArchiveData, type ProjectHistory } from "./historyArchive.ts";
import type { BackupReport } from "./historyBackup.ts";
import type { CachedGameData } from "../project/gameTypes.ts";
import {
  gameEntries,
  PROJECT_SESSION_ID_PATTERN,
  validateTranscript,
  type CreativeSnapshotOffer,
} from "./projectArchiveShared.ts";

/**
 * The complete archive entry list a project download writes, validated but
 * not yet packed. The same construction `buildProjectZip` finishes: callers
 * that must know the prospective stored size — admission before a durable
 * creative publication — measure these exact entries through
 * `measureStoredArchive` instead of estimating from source sizes or
 * allocating the ZIP.
 */
export async function collectProjectArchiveEntries(
  offered: CachedGameData,
  progress?: GameProgress,
  map?: RoomMapSidecar,
  history?: ProjectHistory,
  backup?: BackupReport,
  creative?: CreativeSnapshotOffer,
): Promise<ZipFileInput[]> {
  // The offer is captured before the first await suspends the writer for
  // image hashing: the caller keeps the original objects and may mutate them
  // meanwhile, and a completed backup must still be the game and the source
  // metadata that were offered — cloned native bytes and claims, not a
  // half-mutated mix validated at one moment and serialized at another.
  const data = structuredClone(offered);
  const creativeOffer = creative === undefined ? undefined : structuredClone(creative);
  const entries = gameEntries(data, false);
  // A sound document source claim is admitted only when the strict reader
  // verifies it against this archive's own game — the resolved profile and
  // the stored native SOUND bytes, over exactly the entries being written.
  // Failing here keeps the writer from producing a backup its own reader
  // would refuse. Legacy track bodies keep their existing read-side
  // validation only, and the caller's authoringState is never rewritten.
  const storedSources = data.authoringState?.["sources"];
  const storedSounds =
    storedSources !== null && typeof storedSources === "object" && !Array.isArray(storedSources)
      ? (storedSources as Record<string, unknown>)["sounds"]
      : undefined;
  if (
    Array.isArray(storedSounds) &&
    storedSounds.some((entry) => Array.isArray(entry) && isSoundDocumentEnvelopeClaim(entry[1]))
  ) {
    const archivedFiles = new Map(
      entries.flatMap((entry) =>
        typeof entry.data === "string" ? [] : [[entry.name, entry.data] as const],
      ),
    );
    const archivedContainer = openContainer(
      archivedFiles,
      data.library?.profile ? { profile: data.library.profile } : {},
    );
    const profileId = detectProfile(archivedContainer.files, data.library?.profile).id;
    // A tagged claim keeps editor identity (event ids, allocator cursor), so
    // its resource number must be unique across the sounds sources — a second
    // entry for the same SOUND would silently discard one at map hydration.
    const soundEntryNums = new Map<number, number>();
    for (const entry of storedSounds) {
      if (!Array.isArray(entry)) continue;
      const num: unknown = entry[0];
      if (typeof num === "number" && Number.isInteger(num) && num >= 0 && num <= 255)
        soundEntryNums.set(num, (soundEntryNums.get(num) ?? 0) + 1);
    }
    for (const entry of storedSounds) {
      if (!Array.isArray(entry) || !isSoundDocumentEnvelopeClaim(entry[1])) continue;
      const num: unknown = entry[0];
      if (
        entry.length !== 2 ||
        typeof num !== "number" ||
        !Number.isInteger(num) ||
        num < 0 ||
        num > 255
      )
        throw new Error("Invalid project source entry.");
      if ((soundEntryNums.get(num) ?? 0) > 1)
        throw new Error(`Duplicate sound document source for SOUND ${num}.`);
      readSoundDocumentSource(entry[1], profileId, archivedContainer.getResource("sound", num));
    }
  }
  // Creative assets travel only through an explicit coherent snapshot: a
  // body whose marker claims kept data archives that data or refuses — it
  // is never silently dropped — and a snapshot offered beside a different
  // body, generation, kept revision or playable-byte revision is refused
  // before any bytes are packed. Durable work needs no marker: a project
  // with recovery but no kept set still archives its rows, and the offer
  // must then claim no kept set at all.
  let creativeManifest: Record<string, unknown> | undefined;
  let creativeWorkRecord: Record<string, unknown> | undefined;
  if (data.creative !== undefined || creativeOffer !== undefined) {
    const marker = data.creative;
    if (creativeOffer === undefined)
      throw new Error("This project's kept creative assets were not captured for the archive.");
    if (
      creativeOffer.projectId !== data.projectId ||
      creativeOffer.generation !== (typeof data.generation === "number" ? data.generation : 0)
    )
      throw new Error("The creative snapshot does not match this saved project.");
    if (marker === undefined) {
      if (creativeOffer.manifest !== null || creativeOffer.kept !== 0)
        throw new Error(
          "A creative snapshot was offered for a project without kept creative data.",
        );
    } else {
      if (
        typeof marker !== "object" ||
        Array.isArray(marker) ||
        Object.keys(marker).length !== 1 ||
        !Number.isSafeInteger(marker.kept) ||
        marker.kept < 1 ||
        creativeOffer.kept !== marker.kept ||
        creativeOffer.manifest === null
      )
        throw new Error("The creative snapshot does not match this saved project.");
      // The offer is re-canonicalized through the codec: writing derives the
      // blob registry from the kept claims, and reading checks every nested
      // record — an offer whose declared registry disagrees with its claims is
      // refused rather than silently normalized.
      const manifestRecord = writeCreativeProjectManifest(creativeOffer.manifest);
      const manifest = readCreativeProjectManifest(manifestRecord);
      if (!sameBlobRegistry(manifest.blobs, creativeOffer.manifest.blobs))
        throw new Error("The creative snapshot manifest does not match its blob registry.");
      const offeredBlobs = creativeOffer.blobs;
      if (offeredBlobs === null || typeof offeredBlobs !== "object" || Array.isArray(offeredBlobs))
        throw new Error("Invalid creative snapshot blobs.");
      const declared = creativeProjectBlobHashes(manifest);
      if (
        Object.keys(offeredBlobs).length !== declared.length ||
        declared.some((hash) => !Object.hasOwn(offeredBlobs, hash))
      )
        throw new Error("The creative snapshot blobs do not match its manifest.");
      if (creativeOffer.revision !== (await gameRevision(data.files)))
        throw new Error("The creative snapshot was captured from different game resources.");
      for (const hash of declared) {
        const bytes = offeredBlobs[hash];
        const descriptor = manifest.blobs[hash]!;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length !== descriptor.byteLength ||
          (await sha256Hex(bytes)) !== hash
        )
          throw new Error("A kept creative blob does not match its manifest descriptor.");
        entries.push({ name: `CREATIVE/${hash}.BIN`, data: bytes });
      }
      creativeManifest = manifestRecord;
    }
    // The durable-work half: the envelope re-canonicalizes through its own
    // strict codec, the offered blob map must cover its registry exactly and
    // every body verifies against its declared descriptor. Work blobs share
    // the kept set's content-addressed entries — a hash both sides claim is
    // written once.
    const workBlobs = creativeOffer.workBlobs;
    if (
      workBlobs === null ||
      typeof workBlobs !== "object" ||
      Array.isArray(workBlobs) ||
      (creativeOffer.work === null && Object.keys(workBlobs).length !== 0)
    )
      throw new Error("Invalid creative work snapshot blobs.");
    if (creativeOffer.work !== null) {
      const workRecord = writeCreativeWork(creativeOffer.work);
      const work = readCreativeWork(workRecord);
      const declaredWork = Object.keys(work.blobs).sort(compareCodePoints);
      if (
        Object.keys(workBlobs).length !== declaredWork.length ||
        declaredWork.some((hash) => !Object.hasOwn(workBlobs, hash))
      )
        throw new Error("The creative work blobs do not match its registry.");
      const emitted = new Set(
        entries.flatMap((entry) =>
          entry.name.startsWith("CREATIVE/") && entry.name.endsWith(".BIN")
            ? [entry.name.slice("CREATIVE/".length, -".BIN".length)]
            : [],
        ),
      );
      for (const hash of declaredWork) {
        const bytes = workBlobs[hash];
        const descriptor = work.blobs[hash]!;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length !== descriptor.byteLength ||
          (await sha256Hex(bytes)) !== hash
        )
          throw new Error("A creative work blob does not match its registry descriptor.");
        if (!emitted.has(hash)) entries.push({ name: `CREATIVE/${hash}.BIN`, data: bytes });
      }
      creativeWorkRecord = workRecord;
    }
  }
  if (backup) {
    const { recoveryBatches, ...report } = backup;
    entries.push({ name: "BACKUP.JSON", data: JSON.stringify(report) });
    if (recoveryBatches.length)
      entries.push({
        name: "HISTORY-RECOVERY.JSON",
        data: JSON.stringify({
          format: "monotio.agi.history-recovery",
          version: 1,
          batches: recoveryBatches,
        }),
      });
  }
  const tests = data.files["TESTS.JSON"];
  if (tests) entries.push({ name: "TESTS.JSON", data: tests });
  if (progress) entries.push(...progressEntries(progress));
  // Map data is project UI state: a published game never carries it, and an
  // empty map adds nothing to the archive.
  if (
    map &&
    (map.journal.length || Object.keys(map.layout).length || Object.keys(map.notes).length)
  )
    entries.push({ name: "MAP.JSON", data: mapArchiveData(map) });
  // The session history travels with the project it was recorded in — a
  // published game export never carries it.
  if (history && history.recording.segments.length)
    entries.push({ name: "HISTORY.JSON", data: historyArchiveData(history) });
  const attachments = new Map<string, string>();
  async function visit(value: unknown): Promise<unknown> {
    if (typeof value === "string" && /^(data:image\/(?:png|jpeg|webp);base64,)/.test(value)) {
      const [, mime, b64] = /^data:(image\/[^;]+);base64,(.*)$/.exec(value)!;
      return { projectImage: await attach(b64!, mime!) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (
        object["type"] === "base64" &&
        typeof object["data"] === "string" &&
        typeof object["media_type"] === "string" &&
        /^image\/(png|jpeg|webp)$/.test(object["media_type"])
      ) {
        return {
          projectImage: await attach(object["data"], object["media_type"]),
          anthropicSource: true,
        };
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(object).map(async ([key, child]) => [key, await visit(child)]),
        ),
      );
    }
    return value;
  }
  async function attach(b64: string, mime: string): Promise<string> {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const hash = await sha256Hex(bytes);
    let path = attachments.get(hash);
    if (!path) {
      path = `IMAGES/${hash}.${mime.split("/")[1]}`;
      attachments.set(hash, path);
      entries.push({ name: path, data: bytes });
    }
    return path;
  }
  // An empty provider/model is the stored "no session recorded" sentinel —
  // the same claim as an absent field — so the writer treats it identically.
  // Any non-empty value is a real claim and must be supported.
  const provider = data.provider === "" ? undefined : data.provider;
  const model = data.model === "" ? undefined : data.model;
  const hasAssistant =
    provider !== undefined ||
    model !== undefined ||
    data.sessionId !== undefined ||
    data.transcript !== undefined ||
    data.conversationHistory !== undefined;
  if (
    hasAssistant &&
    (typeof provider !== "string" ||
      !["openai", "anthropic", "stub"].includes(provider) ||
      typeof model !== "string")
  )
    throw new Error("Invalid project model metadata.");
  if (
    data.sessionId !== undefined &&
    (typeof data.sessionId !== "string" || !PROJECT_SESSION_ID_PATTERN.test(data.sessionId))
  )
    throw new Error("Invalid project session field.");
  if (hasAssistant) validateTranscript(data.transcript ?? [], provider!);
  const assistant = hasAssistant
    ? {
        provider: provider!,
        model: model!,
        sessionId: data.sessionId,
        conversation: { formatVersion: 1, messages: await visit(data.transcript ?? []) },
        conversationHistory: await visit(data.conversationHistory ?? []),
      }
    : undefined;
  const workspace =
    data.workspace === undefined
      ? undefined
      : writeProjectWorkspace(readProjectWorkspace(data.workspace));
  const recovered =
    data.recoveryDraft === undefined ? undefined : readProjectRecovery(data.recoveryDraft);
  const recoveryDraft =
    recovered === undefined ? undefined : writeProjectRecovery(recovered.base, recovered.recovery);
  // Reference art is project data: metadata rides in PROJECT.JSON, the bytes
  // in REFERENCES/<id>.<ext> entries. A Game export never carries either.
  // Verify against the live input before rebinding to the exact exported bytes.
  // Private backups preserve resource bytes; rebinding also retains an
  // already-stale attachment's refusal across repeated imports and copies.
  let exportedReferences = data.references;
  if (exportedReferences?.length) {
    const exportedFiles = Object.fromEntries(
      entries.flatMap((entry) =>
        typeof entry.data === "string" ? [] : [[entry.name, entry.data]],
      ),
    );
    const [sourceRevision, destinationRevision] = await Promise.all([
      gameRevision(data.files),
      gameRevision(exportedFiles),
    ]);
    exportedReferences = rebindStagedReferences(
      exportedReferences,
      { project: data.projectId, revision: destinationRevision },
      { project: data.projectId, revision: sourceRevision },
    );
  }
  const references = exportedReferences?.length
    ? exportedReferences.map((reference) => ({
        ...reference,
        images: reference.images.map(({ png: _png, ...meta }) => meta),
      }))
    : undefined;
  for (const reference of data.references ?? [])
    for (const [index, image] of reference.images.entries())
      entries.push({
        name: `REFERENCES/${reference.id}.${index}.${mimeExtension(image.mime)}`,
        data: base64ToBytes(image.png),
      });
  entries.push({
    name: "PROJECT.JSON",
    data: JSON.stringify({
      format: "monotio.agi.project",
      version: 2,
      ...(assistant !== undefined ? { assistant } : {}),
      authoringState: data.authoringState ?? {},
      ...(recoveryDraft !== undefined ? { recoveryDraft } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(creativeManifest !== undefined ? { creative: creativeManifest } : {}),
      ...(creativeWorkRecord !== undefined ? { creativeWork: creativeWorkRecord } : {}),
    }),
  });
  return entries;
}

/** Whether two manifest blob registries name the same descriptors. */
function sameBlobRegistry(
  a: Readonly<Record<BlobHash, RegisteredBlob>>,
  b: Readonly<Record<BlobHash, RegisteredBlob>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((hash) => {
    const entry = b[hash];
    const descriptor = a[hash]!;
    return (
      entry !== undefined &&
      entry.hash === descriptor.hash &&
      entry.byteLength === descriptor.byteLength &&
      entry.mime === descriptor.mime &&
      entry.buckets.length === descriptor.buckets.length &&
      entry.buckets.every((bucket) => descriptor.buckets.includes(bucket))
    );
  });
}
