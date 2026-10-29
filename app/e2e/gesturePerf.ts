interface FrameMeasurement {
  work: number;
  frames: number;
}
type MeasuredWindow = Window & { __pointerFrameMeasure: { active?: FrameMeasurement } };

/** Install before the app captures requestAnimationFrame in its gesture helpers. */
export function installPointerFrameMeasurement() {
  const state: { active?: { work: number; frames: number } } = {};
  Object.assign(window, { __pointerFrameMeasure: state });
  const frame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const sample = state.active;
    return frame((time) => {
      const start = performance.now();
      callback(time);
      if (sample)
        queueMicrotask(() => {
          sample.work += performance.now() - start;
          sample.frames++;
        });
    });
  };
}

/** Measure handlers plus their frame callbacks and Vue effects, excluding the wait for a frame. */
export async function measurePointerFrames(
  element: Element,
  batches: { x: number; y: number }[][],
) {
  const state = (window as unknown as MeasuredWindow).__pointerFrameMeasure;
  const samples: { workMs: number; callbacks: number }[] = [];
  // Settle the initial press before measuring moves.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (const points of batches) {
    const sample: FrameMeasurement = { work: 0, frames: 0 };
    state.active = sample;
    const start = performance.now();
    try {
      for (const { x, y } of points)
        element.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 1,
            button: 0,
            buttons: 1,
            clientX: x,
            clientY: y,
          }),
        );
      await Promise.resolve();
      sample.work += performance.now() - start;
    } finally {
      delete state.active;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!sample.frames)
      throw new Error(
        `The pointer's animation-frame work was not measured (${sample.work} ms in handlers)`,
      );
    samples.push({ workMs: sample.work, callbacks: sample.frames });
  }
  return samples;
}
