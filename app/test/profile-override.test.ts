import test from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { shouldShowProfilePicker, formatProfileResolution } from "../src/profileChoice.ts";
import { addLibraryGame, updateLibraryGameProfile } from "../src/gameLibrary.ts";
import { loadAuthoredGame } from "../src/gameStorage.ts";
import type { OpenedGame } from "../src/gameZip.ts";

installIndexedDbFixture();

function installLocalStorage(t: { after(callback: () => void): void }): void {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
      removeItem(key: string): void {
        values.delete(key);
        Reflect.deleteProperty(this, key);
      },
    },
  });
}

test("shouldShowProfilePicker returns true only for 'default' kind", () => {
  assert.equal(shouldShowProfilePicker("default"), true);
  assert.equal(shouldShowProfilePicker("binary"), false);
  assert.equal(shouldShowProfilePicker("catalog"), false);
});

test("formatProfileResolution names the profile, its source and an unpromoted build", () => {
  assert.equal(formatProfileResolution("2.936", "default"), "2.936 (container default)");
  assert.equal(formatProfileResolution("2.411", "override"), "2.411 (your override)");
  assert.equal(
    formatProfileResolution("2.001", "binary", "2.001"),
    "2.001 (identified from interpreter files)",
  );
  assert.equal(
    formatProfileResolution("2.440", "catalog"),
    "2.440 (identified from the game catalog)",
  );
  assert.equal(
    formatProfileResolution("2.936", "binary", "2.903"),
    "2.936 (build 2.903, no dedicated profile; identified from interpreter files)",
  );
});

test("addLibraryGame and updateLibraryGameProfile persist the profile override", async (t) => {
  installLocalStorage(t);
  const dummyGame: OpenedGame = {
    files: {
      LOGDIR: new Uint8Array(3),
      "WORDS.TOK": new Uint8Array(52),
    },
    words: [],
  };
  const opening = {
    preview:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    status: "ready" as const,
    message: "Opening checked",
    profile: "2.936",
    kind: "default" as const,
  };

  const projectId = await addLibraryGame(
    dummyGame,
    "Override Test",
    "zip",
    opening,
    undefined,
    undefined,
    "2.411",
  );

  const loaded = await loadAuthoredGame(projectId);
  assert.equal(loaded?.library?.profile, "2.411");

  // Update override to another profile
  await updateLibraryGameProfile(projectId, "3.002.086");
  const updated = await loadAuthoredGame(projectId);
  assert.equal(updated?.library?.profile, "3.002.086");

  // Return to automatic (undefined)
  await updateLibraryGameProfile(projectId, undefined);
  const reverted = await loadAuthoredGame(projectId);
  assert.equal(reverted?.library?.profile, undefined);
});
