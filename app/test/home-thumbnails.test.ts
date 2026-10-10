import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { templateThumbnailPng } from "./home-thumbnail-fixture.ts";
import { decodePng } from "../../scripts/png.ts";

for (const kind of ["starter", "boilerplate"] as const) {
  test(`${kind} thumbnail cache matches real template output`, () => {
    const rendered = templateThumbnailPng(kind);
    const cached = readFileSync(new URL(`../src/home/${kind}-thumbnail.png`, import.meta.url));
    // Compression can change across Node/zlib builds; the cache contract is its pixels.
    assert.deepEqual(
      decodePng(cached),
      decodePng(rendered),
      "regenerate the offline thumbnail when its template changes",
    );
  });
}
