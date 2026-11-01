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

test("Amiga timing still applies in this tab when browser storage refuses the choice", () => {
  const settings = createAmigaRegionSettings({
    getItem: () => null,
    setItem: () => {
      throw new Error("Full storage");
    },
  });
  assert.doesNotThrow(() => settings.setRegion("pal"));
  assert.equal(settings.region.value, "pal");
});

test("Amiga timing follows another tab's stored choice and removal", () => {
  let saved: string | null = null;
  const events = new EventTarget();
  const settings = createAmigaRegionSettings(
    {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    },
    events,
  );
  function change(key: string): void {
    events.dispatchEvent(Object.assign(new Event("storage"), { key }));
  }
  saved = "pal";
  change("unrelated");
  assert.equal(settings.region.value, "ntsc");
  change("monotio_agi.amigaRegion");
  assert.equal(settings.region.value, "pal");
  saved = null;
  change("monotio_agi.amigaRegion");
  assert.equal(settings.region.value, "ntsc");
});

test("clearing storage in another tab resets Amiga timing to NTSC", () => {
  let saved: string | null = "pal";
  const events = new EventTarget();
  const settings = createAmigaRegionSettings({ getItem: () => saved, setItem() {} }, events);
  assert.equal(settings.region.value, "pal");
  saved = null;
  events.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  assert.equal(settings.region.value, "ntsc");
});
