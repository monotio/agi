/**
 * Logic Studio's document vocabulary: labels, the unique per-workspace model
 * URI, the explorer's document list, the read-only byte inspector's hex view
 * and the clearly-derived disassembly preview for a bytes-only LOGIC. Nothing
 * here mutates a draft — these are pure reads over the editable project.
 */
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { disassembleLogic } from "../../../../src/logic/disassembler.ts";
import { PROFILES, type ProfileId } from "../../../../src/runtime/profile.ts";

/** The editable document content a workspace document carries. */
export type LogicDocumentContent = string | Uint8Array;

type LogicDocumentKind = "text" | "bytes";

export interface LogicWorkspaceDocument {
  readonly key: string;
  readonly kind: LogicDocumentKind;
  readonly dirty: boolean;
  readonly content: LogicDocumentContent;
}

const RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;
const RESOURCE_LABELS = { logic: "LOGIC", picture: "PIC", view: "VIEW", sound: "SND" } as const;
const AUXILIARY_LABELS: Record<string, string> = {
  words: "WORDS.TOK",
  inventory: "OBJECT",
  bindings: "Bindings",
  world: "World",
  tests: "Tests",
  references: "References",
};

/** What the explorer and tab call one document. */
export function documentLabel(key: string): string {
  const resource = RESOURCE_KEY.exec(key);
  if (resource)
    return `${RESOURCE_LABELS[resource[1] as keyof typeof RESOURCE_LABELS]} ${resource[2]}`;
  return AUXILIARY_LABELS[key] ?? key;
}

/**
 * The editor model URI for one open document. It names the project, this
 * workspace incarnation and the document, so two workspaces on the same
 * project — or a reopened one — never share or collide on a model.
 */
export function logicDocumentUri(projectId: string, workspaceId: string, key: string): string {
  return `agi-logic://${projectId}/${workspaceId}/${encodeURIComponent(key)}`;
}

/** The explorer's listing, in the stored document order. */
export function workspaceDocuments(
  documents: Readonly<Record<string, LogicDocumentContent>>,
  dirty: readonly string[],
): LogicWorkspaceDocument[] {
  const dirtySet = new Set(dirty);
  return Object.entries(documents).map(([key, content]) => ({
    key,
    kind: typeof content === "string" ? "text" : "bytes",
    dirty: dirtySet.has(key),
    content,
  }));
}

/**
 * Read-only byte inspection: offset, uppercase hex and the printable ASCII
 * run, 16 bytes per line. Only for retained native bytes — editing a byte
 * document is not offered.
 */
export function byteLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const chunk = bytes.subarray(at, at + 16);
    const hex = [...chunk]
      .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
      .join(" ")
      .padEnd(47);
    const text = [...chunk]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${at.toString(16).padStart(4, "0").toUpperCase()}  ${hex}  ${text}`);
  }
  return lines;
}

/**
 * A derived reading of retained LOGIC bytes for orientation only: the
 * disassembly is a preview the host marks as derived; it is never installed
 * as the document's authored source.
 */
export function derivedLogicSource(
  payload: Uint8Array,
  profileId: ProfileId,
  words: readonly (readonly [string, number])[],
): { readonly source: string } {
  try {
    return {
      source: disassembleLogic(payload, {
        profile: PROFILES[profileId],
        dictionary: new Map(words),
      }),
    };
  } catch (error) {
    return {
      source: `// The logic does not disassemble: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function invalidContext(document: string, error: unknown): never {
  throw new Error(
    `The ${document} document cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** The draft's vocabulary as analysis context; an unreadable document throws. */
export function analysisWords(
  content: LogicDocumentContent | undefined,
): readonly (readonly [string, number])[] {
  if (typeof content !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    invalidContext("words", error);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 65536 ||
    parsed.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !Number.isInteger(entry[1]) ||
        entry[1] < 0 ||
        entry[1] > 65535,
    )
  )
    throw new Error("The words document cannot be read: it must be an array of [word, group].");
  return parsed.map(([word, group]) => [word, group] as const);
}

/** The draft's bindings as analysis context; an unreadable document throws. */
export function analysisBindings(
  content: LogicDocumentContent | undefined,
): Readonly<Record<string, { readonly num: number }>> {
  if (typeof content !== "string") return {};
  let bindings;
  try {
    bindings = readBindingsDocument(content);
  } catch (error) {
    invalidContext("bindings", error);
  }
  return Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [name, { num: binding.num }]),
  );
}
