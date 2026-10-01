<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { openSprite } from "../../../../src/view/spriteDocument.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import SpriteThumb from "../../world/SpriteThumb.vue";
const props = defineProps<{ bytes: Uint8Array; profile: AgiProfile }>();
const document = computed(() => {
  try {
    return openSprite(props.bytes, props.profile);
  } catch {
    return undefined;
  }
});
const tick = ref(0);
const cels = computed(() => document.value?.loops[2]?.cels ?? document.value?.loops[0]?.cels ?? []);
const cel = computed(() => cels.value[tick.value % cels.value.length]);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    timer = setInterval(() => {
      tick.value++;
    }, 180);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <span class="view-thumbnail"><SpriteThumb v-if="cel" :cel="cel" :width="44" :height="32" /></span>
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
