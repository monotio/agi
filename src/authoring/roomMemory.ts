import { openContainer } from "../container/container.ts";
import { decodeLogicInsns } from "../logic/disassembler.ts";

/** null means the current resources cannot prove whether memory is declared. */
export function hasRoomMemoryDeclaration(
  files: Readonly<Record<string, Uint8Array>>,
): boolean | null {
  try {
    const container = openContainer(new Map(Object.entries(files)));
    let declared = false;
    for (let n = 0; n < 256; n++) {
      const payload = container.getResource("logic", n);
      if (!payload) continue;
      const insns = decodeLogicInsns(payload);
      if (insns.some((i) => i.kind === "data")) return null;
      if (insns.some((i) => i.name === "script.size")) declared = true;
    }
    return declared;
  } catch {
    return null;
  }
}
