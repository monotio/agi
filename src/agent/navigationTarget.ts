export interface Target {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function validateTarget(target: Target): void {
  if (
    ![target.x0, target.x1, target.y0, target.y1].every(Number.isInteger) ||
    target.x0 < 0 ||
    target.x1 > 159 ||
    target.y0 < 0 ||
    target.y1 > 167 ||
    target.x0 > target.x1 ||
    target.y0 > target.y1
  )
    throw new RangeError("Target must be an ordered integer rectangle within 160x168.");
}
