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
 * - LOGIC 0 calls script.size: its largest operand when `includeDeclared`
 *   (a live commit or a host resume, where the boot block already ran),
 *   otherwise 0 because the game's own call sets the buffer;
 * - otherwise, or when LOGIC 0 is missing or cannot be decoded, 0.
 *
 * Callers only ever raise a capacity to this value, never lower one.
 */
export function authoredScriptFloor(
  payload: Uint8Array | null,
  profile: AgiProfile,
  includeDeclared: boolean,
): number {
  if (payload === null) return 0;
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
  if (sized) return includeDeclared ? declared : 0;
  return 0;
}
