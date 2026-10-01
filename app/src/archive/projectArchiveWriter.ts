import { readAgentChats } from "../../../src/agent/chats.ts";
import { externalizeImageAttachments } from "./projectImageArchive.ts";
import { sha256Hex as sha256HexSync } from "../../../src/crypto.ts";
import {
  readProjectHistory,
  writeProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
/**
 * Private project-archive preparation: the exact entry list a project
 * download writes. The file a player opens on Home is never this one —
 * `projectArchive.ts` holds the synchronous readers and the public writer,
 * and loads this module when a project export asks for the full entry list.
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
} from "./projectArchiveShared.ts";

/** The complete, validated entry list for a private project download. */
export async function collectProjectArchiveEntries(
  offered: CachedGameData,
  progress?: GameProgress,
  map?: RoomMapSidecar,
  history?: ProjectHistory,
  backup?: BackupReport,
): Promise<ZipFileInput[]> {
  // The offer is captured before the first await suspends the writer for
  // image hashing: the caller keeps the original objects and may mutate them
  // meanwhile, and a completed backup must still be the game and the source
  // metadata that were offered — cloned native bytes and claims, not a
  // half-mutated mix validated at one moment and serialized at another.
  const data = structuredClone(offered);
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
  const projectHistory =
    data.projectHistory === undefined
      ? undefined
      : writeProjectHistory(readProjectHistory(data.projectHistory, sha256HexSync), sha256HexSync);
  const images = externalizeImageAttachments(workspace, projectHistory, entries);
  entries.push({
    name: "PROJECT.JSON",
    data: JSON.stringify({
      format: "monotio.agi.project",
      version:
        data.chats !== undefined || images.hasAttachments
          ? 4
          : data.projectHistory === undefined
            ? 2
            : 3,
      ...(data.chats !== undefined ? { chats: await visit(readAgentChats(data.chats)) } : {}),
      ...(images.history !== undefined ? { projectHistory: images.history } : {}),
      ...(assistant !== undefined ? { assistant } : {}),
      authoringState: data.authoringState ?? {},
      ...(recoveryDraft !== undefined ? { recoveryDraft } : {}),
      ...(images.workspace !== undefined ? { workspace: images.workspace } : {}),
      ...(references !== undefined ? { references } : {}),
    }),
  });
  return entries;
}
