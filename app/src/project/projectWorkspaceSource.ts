/**
 * Read-only editable-open source adapter. inspectEditableProject reads a
 * stored project's playable bytes beside its claimed authored documents —
 * the version-1 workspace envelope when one exists, else the legacy
 * authoringState.sources arrays — and reports what can be trusted, without
 * writing, seeding or contacting anything.
 *
 * Native files and the selected interpreter profile are the playable truth;
 * the workspace is a claim envelope, never proof. readProjectDocuments
 * enumerates the actual native resources (a missing workspace entry means
 * nothing) and re-associates a claimed source only while it compiles to
 * exactly the stored bytes; byte claims are admitted the same way. Every
 * refused claim — stale text, malformed structure, a byte payload that does
 * not match, source for an absent resource — is set aside in
 * rejectedSources as inactive compatibility data with a diagnostic. Opening
 * always permits editing the verified document inventory. Valid string and byte claims
 * keep their exact content; malformed values are kept as a diagnostic
 * representation. The raw input data stays the preservation
 * authority: a verified document set is a read, not a migration or a save.
 */
import {
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/authoring/authoringState.ts";
import {
  readBindingsDocument,
  readMusicDocument,
  readProjectDocuments,
} from "../../../src/authoring/projectDocuments.ts";
import { readProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import type { CachedGameData } from "./gameTypes.ts";

/** One kept or refused document: authored text or retained native bytes. */
type EditableDocumentContent = string | Uint8Array;

interface EditableSourceDiagnostic {
  readonly key: string;
  readonly message: string;
}

/** What an editable open can prove about one stored project. */
export interface EditableProjectInspection {
  /** The interpreter profile the stored files play under. */
  readonly profileId: ProfileId;
  /**
   * The complete kept document set: every indexed resource and auxiliary
   * file as detached bytes, authored text only where it provably recompiles
   * to those bytes, the bindings document (the exact valid workspace text),
   * and the metadata documents carried through untouched.
   */
  readonly documents: Readonly<Record<string, EditableDocumentContent>>;
  /**
   * Every refused claimed source or native-byte document, under its
   * document key, or its `sources.<list>[<index>]` slot when the claim
   * could not even be read as one. Valid strings and bytes keep their exact
   * content; malformed values are kept as a diagnostic representation for
   * compatibility. Nothing claimed is dropped.
   */
  readonly rejectedSources: Readonly<Record<string, EditableDocumentContent>>;
  readonly diagnostics: readonly EditableSourceDiagnostic[];
  /** Compatibility flag: opening reports diagnostics and always permits editing. */
  readonly requiresSourceReview: boolean;
}

const METADATA_KEYS: Record<string, true> = { world: true, tests: true, references: true };

const RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;

const LEGACY_SOURCE_FIELDS = [
  ["logics", "logic", "text"],
  ["pictures", "picture", "text"],
  ["views", "view", "builder"],
  ["sounds", "sound", "builder"],
] as const;

function describeKey(key: string): string {
  const resource = RESOURCE_KEY.exec(key);
  if (resource) return `${resource[1]!.toUpperCase()} ${resource[2]}`;
  if (key === "words") return "WORDS.TOK";
  if (key === "inventory") return "OBJECT";
  return "document";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render a malformed claim for review without repairing or throwing: valid
 * strings and bytes keep their exact content, anything else becomes a
 * JSON/String rendering or a placeholder. The original input stays the
 * preservation authority.
 */
function preservedClaim(value: unknown): EditableDocumentContent {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text;
  } catch {
    // Fall through to the coarse rendering below.
  }
  try {
    return String(value);
  } catch {
    return "[unreadable claim]";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function sortedRecord(
  documents: Record<string, EditableDocumentContent>,
): Readonly<Record<string, EditableDocumentContent>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/**
 * Extract the legacy authoringState.sources claims into the document-key
 * vocabulary. Logics and pictures are text; views and sounds are JSON
 * builder source. Malformed entries are kept in `rejected` under their
 * `sources.<list>[<index>]` slot as a reviewable representation with a
 * diagnostic — set aside, not repaired.
 */
function legacySourceClaims(
  state: Record<string, unknown> | undefined,
  claims: Record<string, string>,
  rejected: Record<string, EditableDocumentContent>,
  diagnostics: EditableSourceDiagnostic[],
): void {
  const sources = state?.["sources"];
  if (sources === undefined) return;
  if (!isRecord(sources)) {
    diagnostics.push({
      key: "sources",
      message: "The stored source claims are unreadable and were set aside.",
    });
    rejected["sources"] = preservedClaim(sources);
    return;
  }
  for (const [field, kind, form] of LEGACY_SOURCE_FIELDS) {
    const entries = sources[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      diagnostics.push({
        key: `sources.${field}`,
        message: `The stored ${kind} source claims are unreadable and were set aside.`,
      });
      rejected[`sources.${field}`] = preservedClaim(entries);
      continue;
    }
    if (entries.length > 256)
      throw new Error(
        `Cannot open the project for editing: the stored ${kind} source claims exceed the 256-entry limit.`,
      );
    entries.forEach((entry, index) => {
      const slot = `sources.${field}[${index}]`;
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isInteger(entry[0]) ||
        (entry[0] as number) < 0 ||
        (entry[0] as number) > 255
      ) {
        diagnostics.push({
          key: slot,
          message: `A stored ${kind} source claim has no resource number and was set aside.`,
        });
        rejected[slot] = preservedClaim(entry);
        return;
      }
      const key = `${kind}:${entry[0] as number}`;
      // A malformed claim keeps its own sources.<list>[<index>] slot, so it
      // can never overwrite — or be overwritten by — another claim for the
      // same document key.
      const setAside = (message: string, value: unknown): void => {
        diagnostics.push({ key: slot, message });
        rejected[slot] = preservedClaim(value);
      };
      let text: string;
      if (form === "text") {
        if (typeof entry[1] !== "string") {
          setAside(
            `The stored source claim for ${describeKey(key)} is not text and was set aside.`,
            entry[1],
          );
          return;
        }
        text = entry[1];
      } else {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(entry[1]);
        } catch {
          serialized = undefined;
        }
        if (typeof serialized !== "string") {
          setAside(
            `The stored builder claim for ${describeKey(key)} cannot be read and was set aside.`,
            entry[1],
          );
          return;
        }
        text = serialized;
      }
      if (Object.hasOwn(claims, key)) {
        diagnostics.push({
          key: slot,
          message: `A duplicate stored claim for ${describeKey(key)} was set aside.`,
        });
        rejected[slot] = preservedClaim(entry[1]);
        return;
      }
      claims[key] = text;
    });
  }
}

/**
 * The validated legacy authoring state, or undefined when legitimately
 * absent. A present-but-malformed record refuses the whole inspection:
 * fabricating an empty context would pretend named source matches.
 */
function legacyAuthoring(state: Record<string, unknown> | undefined): AuthoringState | undefined {
  if (state === undefined || !Object.hasOwn(state, "authoring")) return undefined;
  try {
    return validateAuthoringState(state["authoring"]);
  } catch (error) {
    throw new Error(
      `Cannot open the project for editing: its stored bindings and world plan are invalid (${reason(error)}).`,
      { cause: error },
    );
  }
}

/**
 * Read a stored project for editing: its profile, the complete native
 * document inventory with only provable authored text attached, every
 * refused claim preserved for comparison, and the diagnostics naming why.
 * Pure: no writes, no re-seeding, no provider, session or worker.
 */
export function inspectEditableProject(data: CachedGameData): EditableProjectInspection {
  const profileId = detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id;

  // An unsupported workspace refuses; there is no downgraded reading.
  let workspace: Readonly<Record<string, string | Uint8Array>> | undefined;
  if (data.workspace !== undefined) {
    try {
      workspace = readProjectWorkspace(data.workspace);
    } catch (error) {
      throw new Error(`Cannot open the project for editing: ${reason(error)}`, {
        cause: error,
      });
    }
  }

  const claims: Record<string, string> = Object.create(null);
  const byteClaims: Record<string, Uint8Array> = Object.create(null);
  const metadata: Record<string, EditableDocumentContent> = Object.create(null);
  const rejected: Record<string, EditableDocumentContent> = Object.create(null);
  const diagnostics: EditableSourceDiagnostic[] = [];
  let bindingsText: string | undefined;

  if (workspace !== undefined) {
    // The workspace is the claim envelope of record: its claims stand alone
    // and are never merged with older legacy sources, so a refused newer
    // claim cannot be silently replaced by stale text that happens to match.
    for (const [key, content] of Object.entries(workspace)) {
      if (key === "bindings") {
        if (typeof content !== "string")
          throw new Error(
            "Cannot open the project for editing: its workspace bindings are not readable text.",
          );
        bindingsText = content;
      } else if (key === "music") {
        // Authored tempo/inspection intent is a strict document: valid text
        // is carried exactly; anything else is set aside, never dropped.
        if (typeof content !== "string") {
          diagnostics.push({
            key,
            message: "The workspace music document is not text and was set aside.",
          });
          rejected[key] = new Uint8Array(content);
        } else {
          try {
            readMusicDocument(content);
            metadata[key] = content;
          } catch (error) {
            diagnostics.push({
              key,
              message: `The workspace music document is invalid and was set aside (${reason(error)}).`,
            });
            rejected[key] = content;
          }
        }
      } else if (Object.hasOwn(METADATA_KEYS, key)) {
        metadata[key] = content instanceof Uint8Array ? new Uint8Array(content) : content;
      } else if (typeof content === "string") {
        claims[key] = content;
      } else {
        byteClaims[key] = new Uint8Array(content);
      }
    }
  } else {
    legacySourceClaims(data.authoringState, claims, rejected, diagnostics);
    const tests = data.files["TESTS.JSON"];
    if (tests !== undefined) metadata["tests"] = new Uint8Array(tests);
  }

  // Bindings come from the workspace bindings document when present, else
  // the validated legacy authoring state; a malformed context refuses rather
  // than fabricating an empty one. Absent context is legitimately empty.
  let bindings: AuthoringState["bindings"];
  let authoring: AuthoringState | undefined;
  if (bindingsText !== undefined) {
    try {
      bindings = readBindingsDocument(bindingsText);
    } catch (error) {
      throw new Error(
        `Cannot open the project for editing: its workspace bindings are invalid (${reason(error)}).`,
        { cause: error },
      );
    }
  } else {
    authoring = legacyAuthoring(data.authoringState);
    bindings = authoring?.bindings ?? {};
  }
  if (metadata["world"] === undefined) {
    authoring ??= legacyAuthoring(data.authoringState);
    if (authoring !== undefined) metadata["world"] = JSON.stringify(authoring.world);
  }
  if (
    metadata["music"] === undefined &&
    !(workspace !== undefined && Object.hasOwn(workspace, "music"))
  ) {
    // Older prepared workspaces have no music document; stored legacy intent
    // hydrates as a canonical document instead of being lost. A workspace
    // music document that was set aside is never shadowed by older state.
    authoring ??= legacyAuthoring(data.authoringState);
    if (authoring?.music !== undefined) metadata["music"] = JSON.stringify(authoring.music);
  }

  const read = readProjectDocuments({
    files: data.files,
    profileId,
    sources: claims,
    bindings,
  });
  diagnostics.push(...read.diagnostics);

  const documents: Record<string, EditableDocumentContent> = Object.create(null);
  for (const [key, content] of Object.entries(read.documents)) documents[key] = content;

  // A text claim re-enters documents only as itself; anything else — a
  // compile failure, a byte mismatch, an absent resource — is refused and
  // preserved, with readProjectDocuments' diagnostic naming the reason.
  for (const [key, text] of Object.entries(claims)) {
    if (documents[key] !== text) rejected[key] = text;
  }
  // A claimed byte payload is admitted only when it equals the native one.
  for (const [key, bytes] of Object.entries(byteClaims)) {
    const held = documents[key];
    if (held instanceof Uint8Array && sameBytes(held, bytes)) continue;
    rejected[key] = bytes;
    diagnostics.push({
      key,
      message:
        held === undefined
          ? `Claimed bytes for ${describeKey(key)} have no playable document and were set aside.`
          : `Claimed bytes for ${describeKey(key)} do not match the playable document and were set aside.`,
    });
  }

  if (bindingsText !== undefined) documents["bindings"] = bindingsText;
  for (const [key, content] of Object.entries(metadata)) documents[key] = content;

  return Object.freeze({
    profileId,
    documents: sortedRecord(documents),
    rejectedSources: sortedRecord(rejected),
    diagnostics: Object.freeze(diagnostics),
    requiresSourceReview: false,
  });
}
