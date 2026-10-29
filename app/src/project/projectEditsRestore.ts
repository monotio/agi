/** Pending-edit downloads use the original journal envelopes and project identities. */
import { projectId, resourceRevision, type ProjectId } from "../../../src/gameIdentity.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import {
  decodeProjectSaveJournal,
  readProjectSaveRecoveries,
  discardProjectSaveRecoveries,
  PROJECT_SAVE_JOURNAL_EVENT,
  type JournalEntry,
} from "./projectSaveJournal.ts";
import { encodeJournalValue } from "./projectJournalCapture.ts";
import { restoreProjectJournals } from "./gameStorage.ts";

const INVALID =
  "These pending edits contain unreadable data. Keep the file and choose another pending-edits download.";

/** Return null for ordinary game archives, which may also carry recovery attachments. */
export async function restoreProjectEdits(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<ProjectId | null> {
  const journals = [...files].filter(([name]) =>
    /^RECOVERY-DATA\/JOURNAL-[1-9]\d*\.JSON$/i.test(name),
  );
  if (
    journals.length === 0 ||
    [...files.keys()].some(
      (name) => !name.endsWith("/") && !/^RECOVERY-DATA\/JOURNAL-[1-9]\d*\.JSON$/i.test(name),
    )
  )
    return null;
  let groups: JournalEntry[][];
  const rawJournals = new Set<string>();
  try {
    groups = journals.map(([, bytes]) => {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      rawJournals.add(raw);
      return decodeProjectSaveJournal(raw);
    });
    for (const entries of groups) {
      if (entries.length === 0) throw new Error(INVALID);
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.attempted !== "boolean" ||
          (entry.automatic !== undefined && typeof entry.automatic !== "boolean") ||
          (entry.capture === undefined) === (entry.request === undefined)
        )
          throw new Error(INVALID);
        const identity = entry.capture?.identity ?? entry.request!;
        const base = entry.capture?.base ?? identity.expected;
        if (
          !identity ||
          !base ||
          projectId(identity.projectId) === null ||
          projectId(identity.commitId) === null ||
          projectId(identity.workspaceId) === null ||
          resourceRevision(identity.buildId) === null ||
          base.projectId !== identity.projectId ||
          typeof base.lifetime !== "string" ||
          !base.lifetime ||
          !Number.isSafeInteger(base.generation) ||
          base.generation < 0 ||
          resourceRevision(base.revision) === null ||
          typeof base.authoring !== "string" ||
          resourceRevision(base.buildId) === null ||
          !identity.expected ||
          JSON.stringify(encodeJournalValue(base)) !==
            JSON.stringify(encodeJournalValue(identity.expected))
        )
          throw new Error(INVALID);
        if (entry.capture !== undefined) {
          if (
            !Array.isArray(entry.capture.operations) ||
            entry.capture.operations.some(
              (operation) =>
                !operation ||
                typeof operation !== "object" ||
                !["capture", "edit", "tag", "renameTag", "chats", "roomGeneration"].includes(
                  operation.kind,
                ),
            ) ||
            !Array.isArray(entry.capture.versions) ||
            entry.capture.versions.some(
              (version) =>
                !version ||
                typeof version.key !== "string" ||
                !Number.isSafeInteger(version.version) ||
                version.version < 0,
            ) ||
            !entry.capture.metadata ||
            typeof entry.capture.metadata !== "object" ||
            typeof entry.capture.image !== "string" ||
            typeof entry.capture.baseImage !== "string" ||
            !Number.isFinite(entry.capture.openedAt)
          )
            throw new Error(INVALID);
          const { hash, ...capture } = entry.capture;
          if (
            sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(capture)))) !==
            hash
          )
            throw new Error(INVALID);
        } else if (
          !Array.isArray(entry.request!.documents) ||
          !entry.request!.data ||
          typeof entry.request!.data !== "object" ||
          !entry.request!.data.files ||
          typeof entry.request!.data.files !== "object" ||
          !Array.isArray(entry.request!.data.words)
        )
          throw new Error(INVALID);
      }
    }
  } catch (error) {
    if (error instanceof Error && /version.*not supported/.test(error.message))
      throw new Error(
        "This version of the pending edits cannot be read by this app. Keep the file and open it with a newer version.",
        { cause: error },
      );
    throw new Error(INVALID, { cause: error });
  }
  const id = groups[0]![0]!.capture?.identity.projectId ?? groups[0]![0]!.request!.projectId;
  if (
    groups.some((entries) =>
      entries.some(
        (entry) => (entry.capture?.identity.projectId ?? entry.request!.projectId) !== id,
      ),
    )
  )
    throw new Error(
      "These pending edits belong to different projects. Keep the file and choose a download from one project.",
    );
  try {
    await restoreProjectJournals(id, groups);
    try {
      const observed = readProjectSaveRecoveries(localStorage, id).filter(({ raw }) =>
        rawJournals.has(raw),
      );
      discardProjectSaveRecoveries(localStorage, id, observed);
      if (typeof dispatchEvent !== "undefined")
        dispatchEvent(new Event(PROJECT_SAVE_JOURNAL_EVENT));
    } catch {
      // The durable restore succeeded; storage may still retain its original recovery notice.
    }
    return id;
  } catch (error) {
    if (error instanceof Error && error.name === "ProjectDeletedError")
      throw new Error(
        "The original project is missing or was reimported. Keep this file and open it in the browser with the original project.",
        { cause: error },
      );
    if (
      error instanceof Error &&
      ["ConcurrencyConflictError", "ProjectExistsError"].includes(error.name)
    )
      throw new Error(
        "The original project changed after these edits were made. Keep this file and open it in the browser with the unchanged original project.",
        { cause: error },
      );
    if (
      error instanceof Error &&
      ["ProjectJournalDecodeError", "ProjectJournalRefusalError"].includes(error.name)
    )
      throw new Error(
        "These pending edits could not be rebuilt for the original project. Keep the file and choose another pending-edits download.",
        { cause: error },
      );
    throw new Error(
      "Browser storage could not restore these edits. Keep the file and try adding it again.",
      { cause: error },
    );
  }
}
