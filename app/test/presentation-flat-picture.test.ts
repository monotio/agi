import assert from "node:assert/strict";
import { test } from "node:test";
import { createPresentation } from "../src/play/usePresentation.ts";
import { FRAME_HEIGHT, FRAME_WIDTH } from "../src/render/composite.ts";
import { EGA_PALETTE } from "../src/render/palette.ts";

/** A 2D canvas that keeps the last picture put on it, as the player would see it. */
function flatCanvas() {
  let shown: Uint8ClampedArray | null = null;
  const ctx = {
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (image: { data: Uint8ClampedArray }) => {
      shown = new Uint8ClampedArray(image.data);
    },
  };
  const canvas = { getContext: (kind: string) => (kind === "2d" ? ctx : null) };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    pixel(x: number, y: number): number[] | null {
      if (!shown) return null;
      const o = (y * FRAME_WIDTH + x) * 4;
      return [shown[o]!, shown[o + 1]!, shown[o + 2]!];
    },
  };
}

function greenRoom() {
  return {
    visual: new Uint8Array(160 * 168).fill(2),
    priority: new Uint8Array(160 * 168).fill(4),
    text: new Uint8Array(40 * 25 * 2),
    picRow: 1,
  };
}

// A still room presents one frame, and the worker can send it before the
// game screen mounts its canvas. Without a GPU stage (no WebGL or WebGPU, or
// the test-mode flat picture) the player sees this canvas, so it must show
// that frame when it mounts rather than stay black until the room changes.
test("the flat picture shows a frame that arrived before the game screen mounted", async () => {
  assert.equal(typeof requestAnimationFrame, "undefined", "present() draws at once in Node");
  const presentation = createPresentation();
  presentation.present(greenRoom());
  const screen = flatCanvas();
  presentation.canvasEl.value = screen.canvas;
  await presentation.initStage(1);
  assert.equal(presentation.gpuBackend.value, undefined, "no GPU stage");
  assert.deepEqual(screen.pixel(0, 8), EGA_PALETTE[2], "picture band shows the room");
  assert.deepEqual(screen.pixel(FRAME_WIDTH - 1, FRAME_HEIGHT - 25), EGA_PALETTE[2]);
});

// The next game's screen mounts before that game's first frame arrives, so
// it must start blank rather than show the previous game's last picture.
test("a new game screen never shows the previous game's picture", async () => {
  const presentation = createPresentation();
  const first = flatCanvas();
  presentation.canvasEl.value = first.canvas;
  await presentation.initStage(1);
  presentation.present(greenRoom());
  assert.deepEqual(first.pixel(0, 8), EGA_PALETTE[2]);
  presentation.closeScreen();
  presentation.canvasEl.value = undefined;
  const next = flatCanvas();
  presentation.canvasEl.value = next.canvas;
  await presentation.initStage(1);
  assert.equal(next.pixel(0, 8), null, "blank until the new game presents");
  const blue = { ...greenRoom(), visual: new Uint8Array(160 * 168).fill(1) };
  presentation.present(blue);
  assert.deepEqual(next.pixel(0, 8), EGA_PALETTE[1]);
});
