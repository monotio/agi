import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick } from "vue";

test("Views overlay retains the viewer's saved opacity", async () => {
  const values: Record<string, string> = { "monotio_agi.pictureViews": "65" };
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    },
  });
  try {
    const { viewOverlayOpacity: opacity } = await import("../src/studio/viewOverlay.ts");
    assert.equal(opacity.value, 65);
    opacity.value = 35;
    await nextTick();
    assert.equal(values["monotio_agi.pictureViews"], "35");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
