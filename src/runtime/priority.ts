/**
 * Baseline priority bands (spec "Priority and horizon" and set.pri.base): an
 * object whose baseline is above `base` gets priority 4; below it the
 * remaining rows split into ten bands 5..14 (15 is reachable only past the
 * surface).
 */
export function priorityForY(y: number, base = 48): number {
  if (y < base) return 4;
  return Math.min(15, 5 + Math.floor(((y - base) * 10) / (168 - base)));
}
