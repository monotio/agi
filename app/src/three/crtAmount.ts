/** Stage ranges shared by the shader and pointer mapping. */
export const CRT_STAGES = {
  phosphor: [0, 0.3],
  light: [0.3, 0.7],
  glass: [0.7, 1],
} as const;

/** Full tube geometry, measured in centred frame coordinates. */
export const CRT_GLASS = { curveX: 0.035, curveY: 0.045, overscan: 0.04, cornerRadius: 0.03 };

/** Cubic smoothstep, matching TSL's smoothstep at each stage boundary. */
export function crtStage(amount: number, start: number, end: number): number {
  const t = Math.min(1, Math.max(0, (amount - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/** Top-left screen UV to the frame sampled by the CRT; border clicks are outside. */
export function crtFramePoint(
  u: number,
  v: number,
  amount: number,
): { x: number; y: number } | null {
  const glass = crtStage(amount, ...CRT_STAGES.glass);
  const cx = u * 2 - 1;
  const cy = v * 2 - 1;
  const overscan = CRT_GLASS.overscan * glass;
  const scale = (1 + overscan) * (1 + 2 * overscan);
  const x = ((cx * (1 + cy * cy * CRT_GLASS.curveX * glass) * scale + 1) / 2) * 320;
  const y = ((cy * (1 + cx * cx * CRT_GLASS.curveY * glass) * scale + 1) / 2) * 200;
  if (x < 0 || x >= 320 || y < 0 || y >= 200) return null;
  return { x, y };
}
