import assert from "node:assert/strict";
import { test } from "node:test";
import { createPresentation } from "../src/play/usePresentation.ts";
import { loadAppearance, PC_APPEARANCE } from "../src/render/appearance.ts";
import { createPcDisplaySettings, readPcDisplay } from "../src/settings/pcDisplay.ts";
import { displayAspect, gameAspectStyle } from "../src/play/viewportLayout.ts";
import type { Frame } from "../src/engine/useEngine.ts";

// Player-visible rules: the game screen switches to the CGA colours as soon
// as they load, even while the game is paused; Studio keeps showing the
// game's own colours; the screen's shape follows the running Amiga region;
// the Screen choice survives a reload and reaches a second tab.

function canvas() {
  const painted: Uint8ClampedArray[] = [];
  const element = {
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image: { data: Uint8ClampedArray }) => painted.push(image.data.slice()),
    }),
  };
  return { element: element as unknown as HTMLCanvasElement, painted };
}

function greenFrame(display?: "cga-rgb"): Frame {
  return {
    visual: new Uint8Array(160 * 168).fill(2),
    priority: new Uint8Array(160 * 168).fill(4),
    text: new Uint8Array(40 * 25 * 2),
    picRow: 1,
    ...(display ? { display, cel: new Uint8Array(160 * 168) } : {}),
  };
}

const pixel = (rgba: Uint8ClampedArray, x: number, y: number) => [
  ...rgba.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4),
];

test("a later profile cancels a pending CGA look", async () => {
  // Runs first, while the CGA look is still unloaded: its request is the slow one.
  const amiga = await loadAppearance("amiga-2.202");
  const presentation = createPresentation();
  presentation.setProfile("2.936", null, "cga-rgb");
  presentation.setProfile("amiga-2.202", null);
  await loadAppearance("2.936", null, "cga-rgb");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentation.appearance, amiga);
});

test("a CGA frame repaints in CGA colours once the look loads, with no new frame", async () => {
  const presentation = createPresentation();
  const { element, painted } = canvas();
  presentation.canvasEl.value = element;
  presentation.setProfile("2.936", null);
  presentation.present(greenFrame("cga-rgb"), undefined, true);
  await loadAppearance("2.936", null, "cga-rgb");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentation.appearance.cgaRgb, true);
  assert.equal(presentation.look.value, PC_APPEARANCE, "Studio keeps the EGA colours");
  const last = painted.at(-1)!;
  // Green on an odd picture row is the binary's pattern 4: green, then blue.
  assert.deepEqual(
    [pixel(last, 0, 9), pixel(last, 1, 9)],
    [
      [0, 170, 0, 255],
      [0, 0, 170, 255],
    ],
  );
  presentation.present(greenFrame(), undefined, true);
  assert.equal(presentation.appearance, PC_APPEARANCE, "an EGA frame goes back to EGA");
});

test("the stage aspect follows the running region and the square-pixel choice", () => {
  assert.equal(displayAspect("2.936", "pal", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.316", "pal", true), 128 / 75);
  assert.equal(displayAspect("amiga-2.316", "ntsc", true), 4 / 3);
  assert.equal(displayAspect("amiga-2.316", "pal", false), 8 / 5);
  assert.deepEqual(gameAspectStyle(128 / 75), {
    "--game-ratio": "calc(128 / 75)",
    "--game-aspect": "128 / 75",
  });
  assert.equal(gameAspectStyle(4 / 3)["--game-aspect"], "4 / 3");
});

test("the Screen choice persists, survives broken storage and reaches a second tab", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const listeners: ((event: Event) => void)[] = [];
  const events = {
    addEventListener: (_type: string, listener: (event: Event) => void) =>
      void listeners.push(listener),
  };
  const first = createPcDisplaySettings(storage, events as unknown as EventTarget);
  const second = createPcDisplaySettings(storage, events as unknown as EventTarget);
  assert.equal(first.display.value, "ega");
  first.setDisplay("cga-rgb");
  assert.equal(stored.get("monotio_agi.pcDisplay"), "cga-rgb");
  for (const listener of listeners)
    listener({ key: "monotio_agi.pcDisplay" } as unknown as StorageEvent);
  assert.equal(second.display.value, "cga-rgb");
  stored.set("monotio_agi.pcDisplay", "hercules");
  assert.equal(readPcDisplay(storage), "ega");
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readPcDisplay(broken), "ega");
  const fallback = createPcDisplaySettings(broken);
  fallback.setDisplay("cga-rgb");
  assert.equal(fallback.display.value, "cga-rgb");
});

test("clearing storage in another tab resets the Screen choice to EGA", () => {
  let saved: string | null = "cga-rgb";
  const events = new EventTarget();
  const settings = createPcDisplaySettings({ getItem: () => saved, setItem() {} }, events);
  assert.equal(settings.display.value, "cga-rgb");
  saved = null;
  events.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  assert.equal(settings.display.value, "ega");
});
