/**
 * The workspace half of a resource Keep. A stored project holds both its
 * playable files and the workspace document envelope each editor opens;
 * a commit that writes new resource bytes or new source claims must leave
 * the envelope agreeing with them in the same write, or the next editable
 * open refuses the stale claims (inspectEditableProject).
 *
 * reconcileResourceWorkspace rewrites only the documents this commit
 * touched — the resources its admitted patches name, byte-changing and
 * source-only alike — with the exact projection readProjectDocuments
 * proves against the saved image: verified authored text where the
 * candidate's claim still compiles to the resource, the native bytes
 * otherwise. Every unrelated document — formatted or commented source,
 * metadata, retained bytes — is preserved exactly, even where the
 * candidate's legacy claims drift from what the workspace verified. The
 * bindings and world documents follow the committed authoring record by
 * semantic value only, keeping their exact held text while the value is
 * unchanged. Never a merge with older state and never a repair of claims
 * the commit did not touch.
 */
import {
  readProjectWorkspace,
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import {
  readBindingsDocument,
  readProjectDocuments,
} from "../../../src/authoring/projectDocuments.ts";
import {
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/authoring/authoringState.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

export interface ResourceWorkspaceInput {
  /** The stored workspace envelope; absent stays absent. */
  readonly workspace: unknown;
  /** The complete native file image the commit is saving. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** The interpreter profile the saved files detect under. */
  readonly profileId: ProfileId;
  /** The authoring record the commit is saving (its `authoring` and `sources`). */
  readonly authoringState: Record<string, unknown> | undefined;
  /**
   * Document keys this commit rewrote — every resource its admitted
   * patches name ("picture:3"), whether bytes or only the claim moved.
   */
  readonly changedDocuments: ReadonlySet<string> | readonly string[];
}

const SOURCE_FIELDS = [
  ["logics", "logic"],
  ["pictures", "picture"],
  ["views", "view"],
  ["sounds", "sound"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray)
    return (
      left.length === (right as unknown[]).length &&
      left.every((item, index) => sameJson(item, (right as unknown[])[index]))
    );
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameJson((left as Record<string, unknown>)[key], rightRecord[key]),
    )
  );
}

/**
 * The claims an authoring record asserts, per document key: logics and
 * pictures as their source text, views and sounds as the JSON of their
 * builder input — the same mapping the editable service writes
 * (editableProject.ts). Malformed entries assert nothing.
 */
function sourceClaims(sources: unknown): Record<string, string> {
  const claims: Record<string, string> = Object.create(null);
  if (!isRecord(sources)) return claims;
  for (const [field, kind] of SOURCE_FIELDS) {
    const entries = sources[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isInteger(entry[0]) ||
        (entry[0] as number) < 0 ||
        (entry[0] as number) > 255
      )
        continue;
      if (field === "views" || field === "sounds") {
        let text: string | undefined;
        try {
          text = JSON.stringify(entry[1]);
        } catch {
          text = undefined;
        }
        if (text !== undefined) claims[`${kind}:${entry[0] as number}`] = text;
      } else if (typeof entry[1] === "string") {
        claims[`${kind}:${entry[0] as number}`] = entry[1];
      }
    }
  }
  return claims;
}

/**
 * The verified workspace envelope for the record a resource commit is
 * saving, or undefined when it carries none. Throws when the stored
 * envelope cannot be read or the committed authoring record is invalid —
 * a Keep that cannot project coherently refuses rather than writing a
 * claim it has not verified.
 */
export function reconcileResourceWorkspace(
  input: ResourceWorkspaceInput,
): PortableProjectWorkspace | undefined {
  if (input.workspace === undefined) return undefined;
  const stored = readProjectWorkspace(input.workspace);
  const claims = sourceClaims(input.authoringState?.["sources"]);
  const heldAuthoring = input.authoringState?.["authoring"];
  const authoring: AuthoringState | undefined =
    heldAuthoring === undefined ? undefined : validateAuthoringState(heldAuthoring);
  const heldBindings = stored["bindings"];
  const bindings =
    authoring?.bindings ??
    readBindingsDocument(typeof heldBindings === "string" ? heldBindings : "{}");
  const verified = readProjectDocuments({
    files: input.files,
    profileId: input.profileId,
    sources: claims,
    bindings,
  });

  const documents: Record<string, string | Uint8Array> = Object.create(null);
  for (const [key, content] of Object.entries(stored)) documents[key] = content;

  // Only the resources this commit admitted: each takes the verified
  // projection — the claim when it reproduces the saved bytes, the exact
  // bytes otherwise — so the envelope never asserts what the files
  // disprove. Claims the commit did not touch stay exactly as held,
  // verified or not, whether or not the legacy record still agrees.
  for (const key of new Set(input.changedDocuments)) {
    const next = verified.documents[key];
    if (next === undefined) delete documents[key];
    else documents[key] = next;
  }

  // The bindings document tracks the committed bindings — a Keep that
  // reserved a name lets its logic claim compile — by semantic value,
  // keeping its exact text while the value is unchanged.
  const canonicalBindings = verified.documents["bindings"];
  if (typeof heldBindings === "string" && typeof canonicalBindings === "string") {
    try {
      if (!sameJson(readBindingsDocument(heldBindings), bindings))
        documents["bindings"] = canonicalBindings;
    } catch {
      documents["bindings"] = canonicalBindings;
    }
  }

  // The world document likewise follows the committed world by value and
  // keeps its exact formatting while it already describes it.
  const world = authoring?.world;
  if (world !== undefined && typeof documents["world"] === "string") {
    try {
      if (!sameJson(JSON.parse(documents["world"] as string), world))
        documents["world"] = JSON.stringify(world);
    } catch {
      documents["world"] = JSON.stringify(world);
    }
  }

  return writeProjectWorkspace(documents);
}
