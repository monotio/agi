import assert from "node:assert/strict";
import { test } from "node:test";
import * as storage from "../src/project/gameStorage.ts";
import { emptyProject, followEmptyProjectRoute } from "../src/home/emptyProjectRoute.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";

installIndexedDbFixture();

test("a stale Create route resolution leaves the newer blank project in place", async (t) => {
  const values = new Map<string, string>();
  const place = { hash: "" };
  for (const [name, value] of [
    [
      "localStorage",
      {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, item: string) => values.set(key, item),
        removeItem: (key: string) => values.delete(key),
      },
    ],
    ["location", place],
    [
      "history",
      { pushState: (_state: unknown, _title: string, hash: string) => (place.hash = hash) },
    ],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.after(() => (emptyProject.value = null));
  for (const key of ["first", "second"])
    await storage.saveAuthoredGame(testProjectId(key), {
      title: key,
      provider: "stub",
      model: "stub",
      files: {},
      words: [],
      transcript: [],
    });
  const first = `#create/${encodeURIComponent(testProjectId("first"))}`;
  const second = `#create/${encodeURIComponent(testProjectId("second"))}`;

  place.hash = second;
  assert.equal(await followEmptyProjectRoute(), true);
  assert.equal(emptyProject.value?.title, "second");

  // Back to the first project, then Forward again before its load finishes.
  place.hash = first;
  const stale = followEmptyProjectRoute();
  place.hash = second;
  assert.equal(await stale, false);
  assert.equal(emptyProject.value?.title, "second");
  assert.equal(place.hash, second);
});
