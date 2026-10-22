import { readonly, ref } from "vue";
import { isPcDisplay, type PcDisplay } from "../../../src/runtime/display.ts";

const KEY = "monotio_agi.pcDisplay";

/** Read the stored PC display preference; EGA when storage is unavailable or holds no choice. */
export function readPcDisplay(storage?: Pick<Storage, "getItem">): PcDisplay {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(KEY);
    return isPcDisplay(value) ? value : "ega";
  } catch {
    return "ega";
  }
}

/**
 * The PC display preference shared by Settings and the next boot. A choice made
 * in another tab arrives through the `storage` event, so both tabs show it.
 */
export function createPcDisplaySettings(
  storage: Pick<Storage, "getItem" | "setItem">,
  events?: Pick<EventTarget, "addEventListener">,
) {
  const display = ref<PcDisplay>(readPcDisplay(storage));
  function setDisplay(value: PcDisplay): void {
    try {
      storage.setItem(KEY, value);
    } catch {
      // The choice still applies to this tab's next start.
    }
    display.value = value;
  }
  events?.addEventListener("storage", (event) => {
    if ((event as StorageEvent).key === KEY) display.value = readPcDisplay(storage);
  });
  return { display: readonly(display), setDisplay };
}

let settings: ReturnType<typeof createPcDisplaySettings> | undefined;

export function usePcDisplay() {
  settings ??= createPcDisplaySettings(localStorage, globalThis);
  return settings;
}
