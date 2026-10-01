/**
 * Compatibility facade over the pure draft-recovery codec in
 * projectRecoveryCodec.ts plus the class-backed restoration. Codec readers
 * and writers import the codec module directly; this entry point keeps the
 * original public API and the synchronous restore signature.
 */
import { ProjectDraft } from "./projectDraft.ts";
import {
  BASE_FIELDS,
  fields,
  plainObject,
  readBase,
  readProjectRecovery,
  type RecoveryBase,
} from "./projectRecoveryCodec.ts";

export {
  PROJECT_RECOVERY_FORMAT,
  PROJECT_RECOVERY_LIMITS,
  readProjectRecovery,
  writeProjectRecovery,
} from "./projectRecoveryCodec.ts";
export type {
  PortableProjectRecovery,
  RecoveryBase,
  RecoveryDocumentContent,
} from "./projectRecoveryCodec.ts";

/**
 * Restore a stored draft after the user chose Restore. The envelope is fully
 * validated and all three saved base identities are compared exactly against
 * the current base before any workspace is constructed; a mismatch is stale
 * recovery, never a silent rebase. The new workspace owns a fresh lifetime:
 * proposals, selections and undo handles from the old workspace carry no
 * authority into it.
 */
export function restoreProjectRecovery(input: {
  readonly documents: Readonly<Record<string, string | Uint8Array>>;
  readonly base: RecoveryBase;
  readonly recovery: unknown;
}): ProjectDraft {
  const request = fields(input, "restore request", ["documents", "base", "recovery"]);
  const { base: saved, recovery } = readProjectRecovery(request["recovery"]);
  const current = readBase(request["base"]);
  const stale = BASE_FIELDS.filter((name) => saved[name] !== current[name]);
  if (stale.length > 0)
    throw new Error(
      `Stale project recovery: saved base ${stale.join(", ")} does not match the current project.`,
    );
  const documents = plainObject(request["documents"], "kept documents");
  return ProjectDraft.recover(documents as Readonly<Record<string, string | Uint8Array>>, recovery);
}
