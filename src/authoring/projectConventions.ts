import { detectProfileDecision } from "../runtime/profile.ts";

/** Additive project metadata; independent of resource revision and undoable History. */
export interface AuthoringConventions {
  version: number;
  legacyRoomMemory?: true;
}
export const AUTHORING_CONVENTIONS_VERSION = 1;
export interface ConventionEvidence {
  files: Readonly<Record<string, Uint8Array>>;
  authoringConventions?: AuthoringConventions | undefined;
  library?: { source?: string | undefined } | undefined;
  imported?: boolean | undefined;
  templateId?: string | undefined;
  provider?: string | undefined;
  sessionId?: string | undefined;
}

/** Original releases always keep their native allocation, even with app metadata. */
export function isRecognizedOriginal(files: ConventionEvidence["files"], librarySource?: string): boolean {
  return librarySource === "catalog" || detectProfileDecision(new Map(Object.entries(files))).kind !== "default";
}

/** Workspace/source claims alone are never evidence of authorship. */
export function isLegacyAuthoredProject(data: ConventionEvidence): boolean {
  if (isRecognizedOriginal(data.files, data.library?.source)) return false;
  if (data.authoringConventions !== undefined) return data.authoringConventions.version === 0 || data.authoringConventions.legacyRoomMemory === true;
  return data.library?.source === "authored" || data.templateId !== undefined || Boolean(data.provider || data.sessionId) || (data.library === undefined && data.imported !== true);
}

/** Compute without writing: commits, copies and exports carry this value. */
export function projectConventions(data: ConventionEvidence): AuthoringConventions {
  return data.authoringConventions?.version === AUTHORING_CONVENTIONS_VERSION ? data.authoringConventions : {version: AUTHORING_CONVENTIONS_VERSION, ...(isLegacyAuthoredProject(data) ? {legacyRoomMemory:true as const} : {})};
}

/** The optional field has its own integer version; unknown versions are refused. */
export function readAuthoringConventions(value: unknown): AuthoringConventions | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid game updates version.");
  const record = value as Record<string,unknown>;
  if ((record["version"] !== 0 && record["version"] !== AUTHORING_CONVENTIONS_VERSION)) throw new Error("Unsupported game updates version.");
  if (record["legacyRoomMemory"] !== undefined && record["legacyRoomMemory"] !== true) throw new Error("Invalid room memory setting.");
  return {version: record["version"] as number, ...(record["legacyRoomMemory"] === true ? {legacyRoomMemory:true} : {})};
}
