/** A viewer's static figure opacity, shared by retained picture tabs. */
import { ref, watch } from "vue";

export const pictureOpensOpacity = ref(0);
try {
  const saved = Number(localStorage.getItem("monotio_agi.pictureOpens"));
  if (Number.isFinite(saved)) pictureOpensOpacity.value = Math.min(100, Math.max(0, saved));
} catch {
  /* Start with the picture alone. */
}
watch(pictureOpensOpacity, (value) => {
  try {
    localStorage.setItem("monotio_agi.pictureOpens", String(value));
  } catch {
    /* Keep the slider's value for this page. */
  }
});
