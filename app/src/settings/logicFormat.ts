import { readonly, ref } from "vue";

/** Optional LOGIC formatting at the editor's leaving boundary. */
function createLogicFormatSettings(storage: Pick<Storage, "getItem" | "setItem">) {
  const formatOnLeaving = ref(storage.getItem("monotio_agi.logicFormatOnLeaving") === "on");
  function setFormatOnLeaving(value: boolean): void {
    storage.setItem("monotio_agi.logicFormatOnLeaving", value ? "on" : "off");
    formatOnLeaving.value = value;
  }
  return { formatOnLeaving: readonly(formatOnLeaving), setFormatOnLeaving };
}
let settings: ReturnType<typeof createLogicFormatSettings> | undefined;
export function useLogicFormatSettings() {
  settings ??= createLogicFormatSettings(localStorage);
  return settings;
}
