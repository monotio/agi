import { readonly, ref } from "vue";
import type { AmigaRegion } from "../audio/paula.ts";

/** Read the persisted clock preference, including when storage is unavailable. */
export function readAmigaRegion(storage?: Pick<Storage, "getItem">): AmigaRegion {
  try {
    return (storage ?? globalThis.localStorage)?.getItem("monotio_agi.amigaRegion") === "pal"
      ? "pal"
      : "ntsc";
  } catch {
    return "ntsc";
  }
}

/** The presentation clock preference, shared by Settings and the audio graph. */
export function createAmigaRegionSettings(storage: Pick<Storage, "getItem" | "setItem">) {
  const region = ref<AmigaRegion>(readAmigaRegion(storage));
  function setRegion(value: AmigaRegion): void {
    storage.setItem("monotio_agi.amigaRegion", value);
    region.value = value;
  }
  return { region: readonly(region), setRegion };
}

let settings: ReturnType<typeof createAmigaRegionSettings> | undefined;

export function useAmigaRegion() {
  settings ??= createAmigaRegionSettings(localStorage);
  return settings;
}
