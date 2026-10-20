<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { openViewDocument } from "../../../../src/view/viewDocument.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import ViewThumb from "../../world/ViewThumb.vue";
const props = defineProps<{ bytes: Uint8Array; profile: AgiProfile }>();
const view = computed(() => {
  try {
    return openViewDocument(props.bytes, props.profile);
  } catch {
    return undefined;
  }
});
const tick = ref(0);
const cels = computed(() => view.value?.loops[2]?.cels ?? view.value?.loops[0]?.cels ?? []);
const cel = computed(() => cels.value[tick.value % cels.value.length]);
let timer: ReturnType<typeof setInterval> | undefined;
const root = useTemplateRef("root");
const visible = ref(false);
const reducedMotion = ref(true);
const pageVisible = ref(true);
let observer: IntersectionObserver | undefined;
let motion: MediaQueryList | undefined;
const updateMotion = () => (reducedMotion.value = motion?.matches ?? true);
const updatePage = () => (pageVisible.value = document.visibilityState === "visible");
watch(
  () => visible.value && pageVisible.value && !reducedMotion.value && cels.value.length > 1,
  (animate) => {
    clearInterval(timer);
    timer = animate ? setInterval(() => tick.value++, 180) : undefined;
  },
);
onMounted(() => {
  motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  updateMotion();
  updatePage();
  motion.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", updatePage);
  observer = new IntersectionObserver(([entry]) => {
    visible.value = entry?.isIntersecting === true;
  });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  observer?.disconnect();
  motion?.removeEventListener("change", updateMotion);
  document.removeEventListener("visibilitychange", updatePage);
});
</script>
<template>
  <span ref="root" class="view-thumbnail"
    ><ViewThumb v-if="cel" :cel="cel" :width="44" :height="32"
  /></span>
</template>
<style scoped>
.view-thumbnail {
  display: grid;
  place-items: center;
  width: 44px;
  height: 32px;
  flex: none;
  overflow: hidden;
}
</style>
