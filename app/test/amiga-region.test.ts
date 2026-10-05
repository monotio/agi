import { test } from "node:test";
import assert from "node:assert/strict";
import { createAmigaRegionSettings } from "../src/settings/amigaRegion.ts";

test("Amiga region defaults to NTSC, persists PAL and ignores unknown preferences", () => {
  let saved: string | null = null;
  const storage = {
    getItem(key: string) {
      assert.equal(key, "monotio_agi.amigaRegion");
      return saved;
    },
    setItem(key: string, value: string) {
      assert.equal(key, "monotio_agi.amigaRegion");
      saved = value;
    },
  };
  const settings = createAmigaRegionSettings(storage);
  assert.equal(settings.region.value, "ntsc");
  settings.setRegion("pal");
  assert.equal(saved, "pal");
  assert.equal(createAmigaRegionSettings(storage).region.value, "pal");
  settings.setRegion("ntsc");
  assert.equal(saved, "ntsc");
  saved = "unknown";
  assert.equal(createAmigaRegionSettings(storage).region.value, "ntsc");
});
