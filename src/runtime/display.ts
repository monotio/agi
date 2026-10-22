/**
 * The PC display adapter a session runs on. EGA is the default; CGA RGB is the
 * four-colour mode the original selects with its `-r` start option
 * (docs/fidelity.md "PC fonts and display adapters").
 */
import type { AgiProfile } from "./profile.ts";

export type PcDisplay = "ega" | "cga-rgb";

/** Monitor type the original keeps for each display: EGA 3, CGA RGB 1 (composite 0). */
export const MONITOR_TYPE: Record<PcDisplay, number> = { ega: 3, "cga-rgb": 1 };

const EGA_ONLY: readonly PcDisplay[] = ["ega"];
const EGA_AND_CGA: readonly PcDisplay[] = ["ega", "cga-rgb"];

/**
 * Displays a session of this profile can start on, each checked in the
 * build's own binaries. PC 2.411 and later accept `-r` and start CGA in RGB
 * mode. 2.089..2.272 start a CGA card in composite mode, reaching RGB only
 * through toggle.monitor, and 2.001 is unverified, so those offer EGA alone.
 * Amiga and IIgs have no PC display.
 */
export function pcDisplaysFor(profile: AgiProfile): readonly PcDisplay[] {
  if (profile.presentation !== "pc") return [];
  switch (profile.id) {
    case "2.001":
    case "2.089":
    case "2.230":
    case "2.272":
      return EGA_ONLY;
    default:
      return EGA_AND_CGA;
  }
}

/** The display a session of this profile actually runs on when `requested` is asked for. */
export function effectivePcDisplay(profile: AgiProfile, requested?: PcDisplay | null): PcDisplay {
  return requested !== undefined && requested !== null && pcDisplaysFor(profile).includes(requested)
    ? requested
    : "ega";
}

export function isPcDisplay(value: unknown): value is PcDisplay {
  return value === "ega" || value === "cga-rgb";
}

/**
 * The view bytes as the CGA driver leaves them in RGB mode. The driver's view
 * conversion sets the table entry of each cel's transparent colour to the
 * transparent code and keeps that entry for the later cels of the same view
 * load, so a later cel's pixels in an earlier cel's transparent colour become
 * transparent too. Loops whose offset repeats the previous loop's are skipped.
 * The colours themselves stay AGI colours here; the compositor applies the
 * driver's cel table (docs/fidelity.md "PC fonts and display adapters").
 */
export function cgaRgbViewPayload(payload: Uint8Array): Uint8Array {
  const out = payload.slice();
  const word = (at: number): number => (out[at] ?? 0) | ((out[at + 1] ?? 0) << 8);
  const hidden = new Uint8Array(16);
  const loops = out[2] ?? 0;
  let last = 0;
  for (let l = 0; l < loops; l++) {
    const loop = word(5 + l * 2);
    if (loop === last) continue;
    last = loop;
    if (loop >= out.length) return out;
    const cels = out[loop]!;
    for (let k = 0; k < cels; k++) {
      const cel = loop + word(loop + 1 + k * 2);
      if (cel + 2 >= out.length) return out;
      const height = out[cel + 1]!;
      const transparent = out[cel + 2]! & 0x0f;
      hidden[transparent] = 1;
      let p = cel + 3;
      for (let row = 0; row < height; row++) {
        for (;;) {
          if (p >= out.length) return out;
          const run = out[p]!;
          if (run === 0) {
            p++;
            break;
          }
          if (hidden[run >> 4]) out[p] = (transparent << 4) | (run & 0x0f);
          p++;
        }
      }
    }
  }
  return out;
}
