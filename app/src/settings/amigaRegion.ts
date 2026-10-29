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
export function createAmigaRegionSettings(
  storage: Pick<Storage, "getItem" | "setItem">,
  events?: Pick<EventTarget, "addEventListener">,
) {
  const region = ref<AmigaRegion>(readAmigaRegion(storage));
  function setRegion(value: AmigaRegion): void {
    try {
      storage.setItem("monotio_agi.amigaRegion", value);
    } catch {
      // The choice still applies to this tab's next start.
    }
    region.value = value;
  }
  events?.addEventListener("storage", (event) => {
    if ((event as StorageEvent).key === "monotio_agi.amigaRegion")
      region.value = readAmigaRegion(storage);
  });
  return { region: readonly(region), setRegion };
}

let settings: ReturnType<typeof createAmigaRegionSettings> | undefined;

export function useAmigaRegion() {
  settings ??= createAmigaRegionSettings(localStorage, globalThis);
  return settings;
}
