/**
 * The pending plan draft: the world-map review's working copy of a genesis
 * plan. It persists across reloads so a kept draft can be reopened, revised
 * or built later; the map sidecar under the same key already carries the
 * layout and notes the game will keep.
 *
 * `monotio_agi.plan.<projectId>` holds one draft;
 * `monotio_agi.pendingPlan` points at the project still being planned.
 */
import { validateAuthoringState } from "../../src/agent/authoringState.ts";
import type { WorldPlan } from "../../src/agent/worldPlan.ts";

const PLAN_PREFIX = "monotio_agi.plan.";
const PENDING_KEY = "monotio_agi.pendingPlan";
const MAX_PLAN_BYTES = 512 * 1024;

export interface StoredPlanDraft {
  version: 1;
  /** The project the built game will own — same target as its map sidecar. */
  projectId: string;
  title: string;
  templateId?: string;
  /** The create request the plan answers — the build turn needs it verbatim. */
  templateMarkdown: string;
  /** worldRevision the draft forked from; "" adopts unconditionally. */
  baseRevision: string;
  world: WorldPlan;
}

function planKey(projectId: string): string {
  return `${PLAN_PREFIX}${projectId}`;
}

export function validatePlanDraft(value: unknown): StoredPlanDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid plan draft: expected an object.");
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== 1) throw new Error("Unsupported plan draft version.");
  if (typeof raw["projectId"] !== "string" || raw["projectId"].length > 128)
    throw new Error("Invalid plan draft project.");
  if (typeof raw["title"] !== "string" || raw["title"].length > 200)
    throw new Error("Invalid plan draft title.");
  if (
    raw["templateId"] !== undefined &&
    (typeof raw["templateId"] !== "string" || raw["templateId"].length > 64)
  )
    throw new Error("Invalid plan draft template.");
  if (typeof raw["templateMarkdown"] !== "string" || raw["templateMarkdown"].length > 65536)
    throw new Error("Invalid plan draft brief.");
  if (typeof raw["baseRevision"] !== "string" || raw["baseRevision"].length > 64)
    throw new Error("Invalid plan draft base revision.");
  // The draft's world goes through the shared validator — same limits as the
  // canonical authoring state, because it becomes one on build.
  const authoring = validateAuthoringState({
    version: 1,
    bindings: {},
    world: raw["world"],
  });
  return {
    version: 1,
    projectId: raw["projectId"] as string,
    title: raw["title"] as string,
    ...(raw["templateId"] !== undefined ? { templateId: raw["templateId"] as string } : {}),
    templateMarkdown: raw["templateMarkdown"] as string,
    baseRevision: raw["baseRevision"] as string,
    world: authoring.world,
  };
}

/** The stored draft for a pending project; missing data is null, malformed throws. */
export function readPlanDraft(
  storage: Pick<Storage, "getItem">,
  projectId: string,
): StoredPlanDraft | null {
  const raw = storage.getItem(planKey(projectId));
  if (raw === null) return null;
  if (raw.length > MAX_PLAN_BYTES) throw new Error("Stored plan draft is too large.");
  try {
    return validatePlanDraft(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Stored plan draft is not readable (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}

export function writePlanDraft(storage: Pick<Storage, "setItem">, draft: StoredPlanDraft): boolean {
  try {
    const raw = JSON.stringify(draft);
    if (raw.length > MAX_PLAN_BYTES) return false;
    storage.setItem(planKey(draft.projectId), raw);
    return true;
  } catch {
    return false;
  }
}

export function removePlanDraft(storage: Pick<Storage, "removeItem">, projectId: string): void {
  storage.removeItem(planKey(projectId));
}

/** The project a kept plan draft belongs to; null when nothing is pending. */
export function readPendingPlan(storage: Pick<Storage, "getItem">): string | null {
  const raw = storage.getItem(PENDING_KEY);
  if (raw === null) return null;
  return raw.length > 0 && raw.length <= 128 ? raw : null;
}

export function writePendingPlan(storage: Pick<Storage, "setItem">, projectId: string): void {
  try {
    storage.setItem(PENDING_KEY, projectId);
  } catch {
    // Quota refusal leaves the draft itself stored; the pointer is a hint.
  }
}

export function clearPendingPlan(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(PENDING_KEY);
}
