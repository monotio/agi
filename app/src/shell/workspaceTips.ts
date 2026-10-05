import { ref } from "vue";
export const tipRevision = ref(0);
const prefix = "monotio_agi.workspaceTip.";
export function tipDismissed(id: string): boolean {
  try {
    return localStorage.getItem(prefix + id) === "done";
  } catch {
    return false;
  }
}
export function dismissTip(id: string): void {
  try {
    localStorage.setItem(prefix + id, "done");
  } catch {
    /* The tip can be replayed in Help. */
  }
  tipRevision.value++;
}
export function showWorkspaceTips(): void {
  for (const id of [
    "workspace",
    "logic",
    "picture",
    "view",
    "sound",
    "words",
    "inventory",
    "notes",
  ]) {
    try {
      localStorage.removeItem(prefix + id);
    } catch {
      /* Tips remain available in this page. */
    }
  }
  tipRevision.value++;
}
