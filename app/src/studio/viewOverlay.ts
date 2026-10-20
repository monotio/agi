/** The viewer's Views overlay opacity, shared by retained picture tabs. */
import { ref, watch } from "vue";

export const viewOverlayOpacity = ref(0);
try {
  const saved = Number(localStorage.getItem("monotio_agi.pictureViews"));
  if (Number.isFinite(saved)) viewOverlayOpacity.value = Math.min(100, Math.max(0, saved));
} catch {
  /* Start with the picture alone. */
}
watch(viewOverlayOpacity, (value) => {
  try {
    localStorage.setItem("monotio_agi.pictureViews", String(value));
  } catch {
    /* Keep the slider's value for this page. */
  }
});
