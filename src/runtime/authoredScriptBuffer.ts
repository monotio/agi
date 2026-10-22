import { decodeLogicInsns } from "../logic/disassembler.ts";
import type { AgiProfile } from "./profile.ts";

/**
 * The script buffer the base template declares in its boot block, and the
 * one the 1.2.5 script buffer migration adds to older authored projects
 * (src/authoring/scriptSizeMigration.ts).
 */
export const AUTHORED_SCRIPT_BUFFER_PAIRS = 200;

/**
 * The smallest script buffer the host option `adoptDeclaredScriptSize`
 * guarantees an authored project whose LOGIC 0 is `payload`
 * (docs/fidelity.md, "Authored script buffer on live edits"):
 *
 * - LOGIC 0 calls script.size: its largest operand on live commit or
 *   host resume, where the boot block already ran;
 * - otherwise the caller's undeclaredFloor on live admission, or 0.
 * Legacy cold boot and restart capacity come from provenance, never from this scan.
 *
 * Callers only ever raise a capacity to this value, never lower one.
 */
export function authoredScriptFloor(
  payload: Uint8Array | null,
  profile: AgiProfile,
  undeclaredFloor = 0,
): number {
  if (payload === null) return undeclaredFloor;
  let insns;
  try {
    insns = decodeLogicInsns(payload, { profile });
  } catch {
    return 0;
  }
  let sized = false;
  let declared = 0;
  for (const insn of insns)
    if (insn.kind === "action" && insn.name === "script.size") {
      sized = true;
      declared = Math.max(declared, insn.args?.[0] ?? 0);
    }
  return sized ? declared : undeclaredFloor;
}
