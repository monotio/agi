<script setup lang="ts">
import { ICONS, type IconName } from "./icons.ts";

const { size = 20, strokeWidth = 2 } = defineProps<{
  name: IconName;
  size?: number;
  strokeWidth?: number;
}>();
</script>

<template>
  <svg
    class="ui-icon"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <component :is="tag" v-for="([tag, attrs], index) in ICONS[name]" :key="index" v-bind="attrs" />
  </svg>
</template>

<style scoped>
.ui-icon {
  display: block;
  flex: none;
}
</style>
