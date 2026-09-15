/**
 * The interpreter's random-number generator (docs/fidelity.md, "Original
 * RNG and wander countdown"): one unsigned 16-bit state word. A draw that
 * enters at zero first reads the host's clock word — the original calls
 * BIOS 1Ah and takes DX — so the reseed is per-draw external input, not
 * one-time initialization: state 58235 advances to zero and the next draw
 * reads the clock again. Then `state * 31821 + 1` is kept to 16 bits and
 * the returned value is `(low ^ high)`, an unsigned byte — the full state
 * persists for the next draw.
 */
export function rngDraw(state: number, reseed: () => number): { state: number; byte: number } {
  let next = state & 0xffff;
  if (next === 0) next = reseed() & 0xffff;
  next = (next * 31821 + 1) & 0xffff;
  return { state: next, byte: (next & 255) ^ (next >>> 8) };
}
