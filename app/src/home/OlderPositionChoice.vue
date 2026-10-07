<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import UiButton from "../ui/UiButton.vue";
const { projectId = undefined, hero = false } = defineProps<{
  projectId?: string;
  hero?: boolean;
}>();
const { state } = useEngineApi();
const { latestVersion, latestVersionAtHero, startLatestVersion, dismissLatestVersion } =
  useGameLibrary();
const shown = computed(
  () =>
    latestVersion.value?.kind === "project" &&
    hero === latestVersionAtHero.value &&
    (hero || latestVersion.value.project === projectId),
);
const root = useTemplateRef("root");
watch(
  shown,
  async (visible) => {
    if (visible) {
      await nextTick();
      root.value?.scrollIntoView({ block: "nearest" });
    }
  },
  { immediate: true },
);
</script>
<template>
  <section
    v-if="shown"
    ref="root"
    class="older-position-choice"
    data-testid="older-position-choice"
    role="status"
  >
    <p>{{ state.error }}</p>
    <div class="older-position-choice__actions">
      <UiButton
        size="sm"
        variant="primary"
        data-testid="start-latest-version"
        @click="startLatestVersion"
        >Start the latest version</UiButton
      >
      <UiButton size="sm" variant="ghost" @click="dismissLatestVersion">Cancel</UiButton>
    </div>
  </section>
</template>
<style scoped>
.older-position-choice {
  margin: var(--space-3) 0;
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink-2);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.older-position-choice p {
  margin: 0 0 var(--space-3);
}
.older-position-choice__actions :deep(.ui-btn) {
  max-width: 100%;
  white-space: normal;
  padding-block: var(--space-2);
}
.older-position-choice__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
