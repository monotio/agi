/** Unfinished work is stored beside the kept project, never as playable resources. */
import { projectId as validProjectId, type ProjectId } from "../../../src/gameIdentity.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
  type PortableProjectRecovery,
  type RecoveryBase,
} from "../../../src/authoring/projectRecoveryCodec.ts";
import type { CachedGameData } from "./gameTypes.ts";
import {
  authoringFingerprint,
  generationOf,
  historyLifetimeGuard,
  projectBodyGuard,
  readBodyRecords,
  updateBodyRecords,
} from "./gameStorage.ts";

/** Never evict unfinished work to make room for a newly opened workspace. */
const MAX_RECOVERY_WORKSPACES = 16;
export interface DraftReceipt {
  readonly incarnation: string;
  readonly sequence: number;
}
interface LocalBase {
  readonly generation: number;
  readonly lifetime: string;
}
interface StoredDraft {
  readonly projectId: string;
  readonly format: "monotio.agi.workspace-draft";
  readonly version: 1;
  readonly workspaceId: string;
  readonly receipt: DraftReceipt;
  readonly expected: LocalBase;
  readonly recovery: PortableProjectRecovery;
}
export interface RecoverableProjectDraft {
  readonly workspaceId: string;
  readonly receipt: DraftReceipt;
  readonly expected: LocalBase;
  readonly recovery: PortableProjectRecovery;
  /** Stale work may be compared or discarded, but must not replace the kept project. */
  readonly status: "current" | "stale";
}

function identity(projectId: ProjectId, workspaceId?: string): void {
  if (
    validProjectId(projectId) === null ||
    (workspaceId !== undefined && validProjectId(workspaceId) === null)
  )
    throw new Error("Invalid recovery workspace identity.");
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Invalid saved recovery record.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key)))
    throw new Error("Unknown saved recovery field.");
  return result;
}
function version(value: unknown, format: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>)["format"] !== format ||
    (value as Record<string, unknown>)["version"] !== 1
  )
    throw new Error("This saved recovery version is not supported by this app.");
  return value as Record<string, unknown>;
}
function readReceipt(value: unknown): DraftReceipt {
  const raw = record(value, ["incarnation", "sequence"]);
  if (
    typeof raw["incarnation"] !== "string" ||
    validProjectId(raw["incarnation"]) === null ||
    !Number.isSafeInteger(raw["sequence"]) ||
    (raw["sequence"] as number) < 1
  )
    throw new Error("Invalid recovery receipt.");
  return { incarnation: raw["incarnation"], sequence: raw["sequence"] as number };
}
function sameReceipt(left: DraftReceipt | null, right: DraftReceipt | null): boolean {
  return left === null || right === null
    ? left === right
    : left.incarnation === right.incarnation && left.sequence === right.sequence;
}
function readLocalBase(value: unknown): LocalBase {
  const raw = record(value, ["generation", "lifetime"]);
  if (
    !Number.isSafeInteger(raw["generation"]) ||
    (raw["generation"] as number) < 0 ||
    typeof raw["lifetime"] !== "string" ||
    !raw["lifetime"] ||
    raw["lifetime"].length > 128
  )
    throw new Error("Invalid saved recovery base.");
  return { generation: raw["generation"] as number, lifetime: raw["lifetime"] };
}
function readManifest(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  version(value, "monotio.agi.workspace-drafts");
  const raw = record(value, ["projectId", "format", "version", "workspaces"]);
  const workspaces = raw["workspaces"];
  if (
    raw["projectId"] !== key ||
    !Array.isArray(workspaces) ||
    workspaces.length > MAX_RECOVERY_WORKSPACES ||
    Array.from(workspaces).some((id) => typeof id !== "string" || validProjectId(id) === null) ||
    new Set(workspaces).size !== workspaces.length
  )
    throw new Error("Invalid recovery workspace list.");
  return [...workspaces].sort();
}
function readDraft(value: unknown, key: string, workspaceId: string): StoredDraft {
  version(value, "monotio.agi.workspace-draft");
  const raw = record(value, [
    "projectId",
    "format",
    "version",
    "workspaceId",
    "receipt",
    "expected",
    "recovery",
  ]);
  if (raw["projectId"] !== key || raw["workspaceId"] !== workspaceId)
    throw new Error("Invalid saved recovery identity.");
  const decoded = readProjectRecovery(raw["recovery"]);
  return {
    projectId: key,
    format: "monotio.agi.workspace-draft",
    version: 1,
    workspaceId,
    receipt: readReceipt(raw["receipt"]),
    expected: readLocalBase(raw["expected"]),
    recovery: writeProjectRecovery(decoded.base, decoded.recovery),
  };
}
function matches(data: CachedGameData, expected: LocalBase, base: RecoveryBase): boolean {
  return (
    generationOf(data) === expected.generation &&
    data.library?.revision === base.revision &&
    authoringFingerprint(data.authoringState, data.workspace) === base.authoring &&
    detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id === base.profileId
  );
}

/** Capture before awaiting; publish the draft and its discovery index atomically. */
export async function saveProjectDraft(input: {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly expectedReceipt: DraftReceipt | null;
  readonly expected: LocalBase;
  readonly recovery: unknown;
}): Promise<DraftReceipt> {
  identity(input.projectId, input.workspaceId);
  const { projectId, workspaceId } = input;
  const expectedReceipt =
    input.expectedReceipt === null ? null : readReceipt(input.expectedReceipt);
  const expected = readLocalBase(input.expected);
  const decoded = readProjectRecovery(input.recovery);
  const recovery = writeProjectRecovery(decoded.base, decoded.recovery);
  const manifestKey = `draft/${projectId}`;
  const key = `${manifestKey}/${workspaceId}`;
  let previous: StoredDraft | undefined;
  return updateBodyRecords(
    manifestKey,
    (raw) => {
      const workspaces = readManifest(raw, manifestKey);
      if (
        !sameReceipt(previous?.receipt ?? null, expectedReceipt) ||
        (previous !== undefined && previous.expected.lifetime !== expected.lifetime)
      )
        throw new Error("This recovery changed; read the latest draft before saving again.");
      if (workspaces.includes(workspaceId) !== (previous !== undefined))
        throw new Error("The saved recovery index is inconsistent and was left unchanged.");
      if (!workspaces.includes(workspaceId)) {
        if (workspaces.length >= MAX_RECOVERY_WORKSPACES)
          throw new Error(
            "Too many recoverable workspaces. Restore or discard an older draft first.",
          );
        workspaces.push(workspaceId);
        workspaces.sort();
      }
      const sequence = (previous?.receipt.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Recovery sequence limit reached.");
      const receipt = {
        incarnation: previous?.receipt.incarnation ?? crypto.randomUUID(),
        sequence,
      };
      return {
        result: receipt,
        puts: [
          {
            projectId: manifestKey,
            format: "monotio.agi.workspace-drafts",
            version: 1,
            workspaces,
          },
          {
            projectId: key,
            format: "monotio.agi.workspace-draft",
            version: 1,
            workspaceId,
            receipt,
            expected,
            recovery,
          } satisfies StoredDraft,
        ],
      };
    },
    [
      historyLifetimeGuard(projectId, expected.lifetime),
      projectBodyGuard(projectId, (data) => {
        if (!matches(data, expected, decoded.base))
          throw new Error("This recovery base is stale; the saved project changed.");
      }),
      {
        key,
        check(raw) {
          previous = raw === undefined ? undefined : readDraft(raw, key, workspaceId);
        },
      },
    ],
  );
}

/** Read every tab's recovery and the kept base from the same database snapshot. */
export async function listProjectDrafts(
  projectId: ProjectId,
): Promise<readonly RecoverableProjectDraft[]> {
  identity(projectId);
  const manifestKey = `draft/${projectId}`;
  const snapshot = await readBodyRecords(manifestKey, (raw) => [
    projectId,
    `lifetime/${projectId}`,
    ...readManifest(raw, manifestKey).map((id) => `${manifestKey}/${id}`),
  ]);
  const workspaces = readManifest(snapshot.head, manifestKey);
  if (!workspaces.length) return [];
  let current: CachedGameData | undefined;
  const body = snapshot.records.get(projectId);
  if (body !== undefined)
    projectBodyGuard(projectId, (data) => {
      current = data;
    }).check(body);
  return workspaces.map((workspaceId) => {
    const key = `${manifestKey}/${workspaceId}`;
    const stored = readDraft(snapshot.records.get(key), key, workspaceId);
    let live = true;
    try {
      historyLifetimeGuard(projectId, stored.expected.lifetime).check(
        snapshot.records.get(`lifetime/${projectId}`),
      );
    } catch {
      live = false;
    }
    return {
      workspaceId,
      receipt: stored.receipt,
      expected: stored.expected,
      recovery: stored.recovery,
      status:
        live && current !== undefined && matches(current, stored.expected, stored.recovery.base)
          ? "current"
          : "stale",
    };
  });
}

/** Explicit discard uses the reviewed draft identity and sequence, even when the kept base has changed. */
export async function discardProjectDraft(
  projectId: ProjectId,
  workspaceId: string,
  expectedReceipt: DraftReceipt,
): Promise<void> {
  identity(projectId, workspaceId);
  const receipt = readReceipt(expectedReceipt);
  const manifestKey = `draft/${projectId}`;
  const key = `${manifestKey}/${workspaceId}`;
  let previous: StoredDraft | undefined;
  await updateBodyRecords(
    manifestKey,
    (raw) => {
      const workspaces = readManifest(raw, manifestKey);
      if (!sameReceipt(previous?.receipt ?? null, receipt))
        throw new Error("This recovery changed; review the latest draft before discarding it.");
      if (!workspaces.includes(workspaceId))
        throw new Error("The saved recovery index is inconsistent and was left unchanged.");
      const remaining = workspaces.filter((id) => id !== workspaceId);
      return {
        result: undefined,
        deletes: remaining.length ? [key] : [key, manifestKey],
        ...(remaining.length
          ? {
              puts: [
                {
                  projectId: manifestKey,
                  format: "monotio.agi.workspace-drafts",
                  version: 1,
                  workspaces: remaining,
                },
              ],
            }
          : {}),
      };
    },
    {
      key,
      check(raw) {
        previous = raw === undefined ? undefined : readDraft(raw, key, workspaceId);
      },
    },
  );
}
