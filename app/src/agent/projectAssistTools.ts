import { toolDescription, parameterDescriptions } from "../../../src/vocabulary.ts";
/**
 * The project assist tool catalog and its deny-by-default dispatcher.
 *
 * One driver instance serves one captured AgentWorkspace (one request). The
 * model gets a narrow set: complete-context read, bounded exact document
 * reads, one validated coordinated proposal tool and a withdraw. Every
 * proposal goes through the real compiler + reference checks inside
 * `workspace.propose`; a refused change set issues nothing and preserves any
 * previously issued proposal. Nothing here applies, saves or installs.
 */
import { sha256Hex } from "../../../src/crypto.ts";
import { AUTHORING_GUIDE_TOOL, readAuthoringGuide } from "../../../src/agent/authoringGuide.ts";
import {
  COMMAND_REFERENCE_TOOL,
  readCommandReference,
} from "../../../src/agent/commandReference.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import {
  normalizeToolArguments,
  validateToolArguments,
} from "../../../src/agent/schemaValidate.ts";
import type { ToolDefinition } from "../../../src/agent/tools.ts";
import {
  AgentCandidateError,
  type AgentCandidateDiagnostic,
  type AgentWorkspace,
} from "../../../src/authoring/projectAgentCandidate.ts";
import { checkProjectDocumentKey, type ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";

type WorkspaceProposal = ReturnType<ProjectDraft["propose"]>;
type DocumentContent = string | Uint8Array;

/** Largest single document read page, in UTF-16 code units. */
const MAX_READ_TEXT_CHARS = 131072;
/** Default document read page, in UTF-16 code units. */
const DEFAULT_READ_TEXT_CHARS = MAX_READ_TEXT_CHARS;
/** Largest byte window a binary document read may return, in bytes. */
const MAX_READ_BYTES = 65536;
/** Longest single proposed document text, in UTF-16 code units. */
const MAX_PROPOSE_TEXT_CHARS = 131072;

export const PROJECT_ASSIST_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_project_context",
    description: toolDescription(
      "read_project_context",
      "List the captured draft's complete document set: every key, its kind and size, the interpreter profile, the compile/reference diagnostics and this request's pending proposal. Reads always describe the captured base, never an unissued edit.",
    ),
    parameters: parameterDescriptions("read_project_context", {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    }),
  },
  {
    name: "read_document",
    description: toolDescription(
      "read_document",
      "Read one captured document exactly as authored. current draft text including comments and invalid syntax, never a decompiled substitute. Text pages by zero-based UTF-16 offset and limit (default and maximum 131072 code units). A byte document reports its length and SHA-256 plus a base64 window (default and maximum 65536 bytes).",
    ),
    parameters: parameterDescriptions("read_document", {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", maxLength: 64 },
        offset: { type: ["integer", "null"], minimum: 0 },
        limit: { type: ["integer", "null"], minimum: 1, maximum: MAX_READ_TEXT_CHARS },
      },
      required: ["key", "offset", "limit"],
    }),
  },
  {
    name: "propose_changes",
    description: toolDescription(
      "propose_changes",
      "Offer one complete replacement change set over the captured documents: each change writes one document's whole text (ordinary AGI source or JSON) or deletes it (content null). The host overlays the set onto the captured base and validates the ENTIRE resulting project. real compiler plus reference checks. before issuing a reviewable draft proposal. A refused set returns document-scoped diagnostics and keeps the previously issued proposal. A successful call replaces this request's pending proposal, so gather every coordinated change (logic, words, bindings, inventory, world) into one call. Nothing is applied, saved or installed.",
    ),
    parameters: parameterDescriptions("propose_changes", {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", minLength: 1, maxLength: 160 },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", maxLength: 64 },
              content: { type: ["string", "null"], maxLength: MAX_PROPOSE_TEXT_CHARS },
            },
            required: ["key", "content"],
          },
        },
      },
      required: ["label", "changes"],
    }),
  },
  {
    name: "withdraw_changes",
    description: toolDescription(
      "withdraw_changes",
      "Discard this request's pending proposal so the reviewer is never offered it. Use when you conclude your own candidate should not be accepted.",
    ),
    parameters: parameterDescriptions("withdraw_changes", {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: ["string", "null"], maxLength: 2000 },
      },
      required: ["reason"],
    }),
  },
  COMMAND_REFERENCE_TOOL,
  AUTHORING_GUIDE_TOOL,
];

export const PROJECT_ASSIST_TOOL_NAMES: readonly string[] = PROJECT_ASSIST_TOOLS.map(
  (tool) => tool.name,
);

/** One request's proposal bookkeeping behind the tool surface. */
export interface ProjectAssistDriver {
  readonly baseRevision: number;
  /** Dispatch one provider tool call. Names outside the catalog are denied. */
  execute(name: string, args: Record<string, unknown>): AgentToolResult;
  /** The currently pending issued proposal, or null. */
  pending(): WorkspaceProposal | null;
  /** Successful propose_changes calls this request. */
  readonly proposals: number;
  /** Refused propose attempts this request. */
  readonly refusals: number;
  /** Document-scoped diagnostics from the most recent refusal. */
  readonly lastDiagnostics: readonly AgentCandidateDiagnostic[];
}

const UTF8 = new TextEncoder();

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const bits = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      alphabet[(bits >>> 18) & 63]! +
      alphabet[(bits >>> 12) & 63]! +
      (index + 1 < bytes.length ? alphabet[(bits >>> 6) & 63]! : "=") +
      (index + 2 < bytes.length ? alphabet[bits & 63]! : "=");
  }
  return out;
}

function sameContent(a: DocumentContent | undefined, b: DocumentContent | null): boolean {
  if (a === undefined || b === null) return a === undefined && b === null;
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Create the per-request tool dispatcher over one captured workspace. */
export function createProjectAssistDriver(workspace: AgentWorkspace): ProjectAssistDriver {
  let pending: WorkspaceProposal | null = null;
  let proposals = 0;
  let refusals = 0;
  let lastDiagnostics: readonly AgentCandidateDiagnostic[] = [];
  const profile = PROFILES[workspace.profileId]!;

  function context(): AgentToolResult {
    const documents = workspace.documents();
    const keys = Object.keys(documents).sort();
    const listing = keys.map((key) => ({
      key,
      kind: typeof documents[key] === "string" ? "text" : "bytes",
      size:
        typeof documents[key] === "string"
          ? (documents[key] as string).length
          : (documents[key] as Uint8Array).byteLength,
      version: workspace.base.version(key),
    }));
    const diagnostics = workspace.diagnostics.slice(0, 32).map((d) => ({ ...d }));
    return {
      success: true,
      message:
        `Profile ${workspace.profileId}; ${keys.length} documents; ` +
        `${workspace.compilable ? "the captured set compiles" : "the captured set does not compile"}; ` +
        `${workspace.diagnostics.length} diagnostic(s). ` +
        (pending
          ? `A proposal is pending: ${pending.label} (${pending
              .changes()
              .map((c) => c.key)
              .join(", ")}).`
          : "No proposal is pending."),
      details: {
        profileId: workspace.profileId,
        baseRevision: workspace.base.revision,
        compilable: workspace.compilable,
        documentCount: keys.length,
        documents: listing,
        diagnostics,
        ...(diagnostics.length < workspace.diagnostics.length
          ? { diagnosticsOmitted: workspace.diagnostics.length - diagnostics.length }
          : {}),
        pendingProposal: pending
          ? { label: pending.label, keys: pending.changes().map((c) => c.key) }
          : null,
      },
    };
  }

  function readDocument(args: Record<string, unknown>): AgentToolResult {
    const key = String(args["key"] ?? "");
    try {
      checkProjectDocumentKey(key);
    } catch {
      return { success: false, error: `'${key}' is not a project document key.` };
    }
    const content = workspace.documents()[key];
    if (content === undefined) {
      const keys = Object.keys(workspace.documents()).sort();
      return {
        success: false,
        error: `No document '${key}'. Documents: ${keys.slice(0, 48).join(", ")}${keys.length > 48 ? ", …" : ""}.`,
      };
    }
    const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
    if (typeof content === "string") {
      const limit = Math.min(
        typeof args["limit"] === "number" ? args["limit"] : DEFAULT_READ_TEXT_CHARS,
        MAX_READ_TEXT_CHARS,
      );
      const page = content.slice(offset, offset + limit);
      const next = offset + limit < content.length ? offset + limit : null;
      return {
        success: true,
        message:
          `${key}: text, ${content.length} code units, offset ${offset}${next === null ? "" : `, continues at ${next}`}:\n` +
          page,
        details: {
          key,
          kind: "text",
          length: content.length,
          offset,
          nextOffset: next,
          sha256: sha256Hex(UTF8.encode(content)),
        },
      };
    }
    const limit = Math.min(
      typeof args["limit"] === "number" ? args["limit"] : MAX_READ_BYTES,
      MAX_READ_BYTES,
    );
    const window = content.slice(offset, offset + limit);
    const next = offset + limit < content.length ? offset + limit : null;
    return {
      success: true,
      message:
        `${key}: ${content.byteLength} bytes, sha256 ${sha256Hex(content)}. ` +
        `base64 window at offset ${offset} (${window.length} bytes${next === null ? "" : `, continues at ${next}`}): ${base64(window)}`,
      details: {
        key,
        kind: "bytes",
        length: content.byteLength,
        offset,
        nextOffset: next,
        sha256: sha256Hex(content),
        base64: base64(window),
      },
    };
  }

  function propose(args: Record<string, unknown>): AgentToolResult {
    const label = String(args["label"] ?? "");
    const raw = Array.isArray(args["changes"]) ? (args["changes"] as unknown[]) : [];
    const keyErrors: string[] = [];
    const seen = new Set<string>();
    const changes: { key: string; content: string | null }[] = [];
    for (const entry of raw) {
      const item = entry as Record<string, unknown>;
      const key = String(item["key"] ?? "");
      try {
        checkProjectDocumentKey(key);
      } catch {
        keyErrors.push(`'${key}' is not a project document key.`);
        continue;
      }
      if (seen.has(key)) keyErrors.push(`Duplicate project document: ${key}`);
      seen.add(key);
      const content = item["content"];
      changes.push({ key, content: content === null ? null : String(content) });
    }
    if (keyErrors.length)
      return {
        success: false,
        error: `Invalid arguments for propose_changes; nothing was changed. ${[...new Set(keyErrors)].join(" ")}`,
      };
    const base = workspace.documents();
    const effective = changes.filter(({ key, content }) => !sameContent(base[key], content));
    if (effective.length === 0)
      return {
        success: false,
        error:
          "The change set produces no difference from the captured documents; nothing was proposed.",
      };
    try {
      const proposal = workspace.propose(label, changes);
      const replaced = pending !== null;
      pending = proposal;
      proposals++;
      lastDiagnostics = [];
      return {
        success: true,
        message:
          `Proposal issued for review: ${changes.map((c) => c.key).join(", ")}. ` +
          "The complete resulting document set compiled and passed reference checks. " +
          "Nothing is applied until the reviewer approves it." +
          (replaced ? " This replaced the request's earlier pending proposal." : ""),
        details: {
          label,
          keys: changes.map((c) => c.key),
          deletions: changes.filter((c) => c.content === null).map((c) => c.key),
          replacedPending: replaced,
        },
      };
    } catch (error) {
      refusals++;
      lastDiagnostics =
        error instanceof AgentCandidateError
          ? error.diagnostics
          : [{ key: null, severity: "error" as const, message: String(error) }];
      const cause = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Refused; nothing was proposed${pending ? " (the earlier proposal still stands)" : ""}: ${cause}`,
        details: { diagnostics: lastDiagnostics.map((d) => ({ ...d })) },
      };
    }
  }

  function withdraw(args: Record<string, unknown>): AgentToolResult {
    const reason = typeof args["reason"] === "string" ? args["reason"] : null;
    if (!pending) return { success: false, error: "There is no pending proposal to withdraw." };
    const label = pending.label;
    pending = null;
    return {
      success: true,
      message: `Withdrew the pending proposal '${label}'. The reviewer will not be offered it.${reason ? ` Reason: ${reason}` : ""}`,
      details: { withdrawn: label, reason },
    };
  }

  return {
    baseRevision: workspace.base.revision,
    execute(name, args) {
      const definition = PROJECT_ASSIST_TOOLS.find((tool) => tool.name === name);
      if (!definition)
        return {
          success: false,
          error: `'${name}' is not available in this phase of the session.`,
        };
      const normalized = normalizeToolArguments(
        definition.parameters,
        args && typeof args === "object" ? args : {},
      );
      const errors = validateToolArguments(definition.parameters, normalized);
      if (errors.length)
        return {
          success: false,
          error: `Invalid arguments for ${name}; nothing was changed. ${[...new Set(errors)].join(" ")}`,
        };
      switch (name) {
        case "read_project_context":
          return context();
        case "read_document":
          return readDocument(normalized);
        case "propose_changes":
          return propose(normalized);
        case "withdraw_changes":
          return withdraw(normalized);
        case "read_command_reference":
          return readCommandReference(profile, normalized);
        case "read_authoring_guide":
          return readAuthoringGuide(normalized);
        default:
          return {
            success: false,
            error: `'${name}' is not available in this phase of the session.`,
          };
      }
    },
    pending: () => pending,
    get proposals() {
      return proposals;
    },
    get refusals() {
      return refusals;
    },
    get lastDiagnostics() {
      return lastDiagnostics;
    },
  };
}
