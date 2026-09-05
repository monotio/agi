import assert from "node:assert/strict";
import { test } from "node:test";
import * as storage from "../src/cartridgeStorage.ts";

test("renaming preserves cartridge resources, conversation and save identity", async (t) => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  await storage.saveAuthoredCartridge("custom", {
    title: "Custom Cartridge",
    provider: "stub",
    model: "stub",
    files: { "VOL.0": Uint8Array.of(1, 2, 3) },
    words: [],
    transcript: [{ text: "Original" }],
  });
  const original = (await storage.loadAuthoredCartridge("custom"))!;
  assert.equal(await storage.renameAuthoredCartridge("custom", "  My adventure  "), true);
  assert.deepEqual(await storage.loadAuthoredCartridge("custom"), {
    ...original,
    title: "My adventure",
  });
  assert.equal(await storage.renameAuthoredCartridge("custom", "   "), false);
  assert.equal(await storage.renameAuthoredCartridge("absent", "New title"), false);
});
