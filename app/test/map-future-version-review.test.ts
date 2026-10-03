import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMapSidecar, mapKey, writeMapSidecar } from "../src/world/roomMapStore.ts";

const target = `installed:${"a".repeat(64)}`;

test("map writes preserve an unsupported future record byte for byte", () => {
  const original = '{ "format": "monotio.agi.map", "version": 2, "future": { "route": [7, 9] } }\n';
  const values = new Map([[mapKey(target), original]]);
  let writes = 0;
  const storage = {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      writes++;
      values.set(key, value);
    },
  };
  assert.equal(writeMapSidecar(storage, target, emptyMapSidecar()), false);
  assert.equal(writes, 0);
  assert.equal(values.get(mapKey(target)), original);
});

test("a failed map read refuses the write before replacing progress", () => {
  let writes = 0;
  const storage = {
    getItem(): string | null {
      throw new Error("Injected storage read refusal");
    },
    setItem(): void {
      writes++;
    },
  };
  assert.equal(writeMapSidecar(storage, target, emptyMapSidecar()), false);
  assert.equal(writes, 0);
});
