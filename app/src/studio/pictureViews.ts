/** A viewer's static figure opacity, shared by retained picture tabs. */
import { ref, watch } from "vue";

export const pictureViewsOpacity = ref(0);
try {
  const saved = Number(localStorage.getItem("monotio_agi.pictureViews"));
  if (Number.isFinite(saved)) pictureViewsOpacity.value = Math.min(100, Math.max(0, saved));
} catch {
  /* Start with the picture alone. */
}
watch(pictureViewsOpacity, (value) => {
  try {
    localStorage.setItem("monotio_agi.pictureViews", String(value));
  } catch {
    /* Keep the slider's value for this page. */
  }
});
