<script setup lang="ts">
import { computed, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiButton from "../../ui/UiButton.vue";
export interface ContextAction {
  id: string;
  label: string;
  disabled: boolean;
  title?: string;
  testId?: string;
  run(): unknown;
}
const { actions, secondary } = defineProps<{
  /** Frequent actions in descending priority. */
  actions: readonly ContextAction[];
  secondary: readonly ContextAction[];
}>();
const row = useTemplateRef("row");
const measure = useTemplateRef("measure");
const visibleCount = ref(0);
const overflow = computed(() => [...actions.slice(visibleCount.value), ...secondary]);
watch(
  [
    row,
    measure,
    () => actions.map((action) => action.label).join("\u0000"),
    () => secondary.length,
  ],
  () => {
    const target = row.value;
    const probe = measure.value;
    if (!target || !probe) return;
    function fit(): void {
      if (!target || !probe) return;
      const widths = Array.from(probe.children, (child) => child.getBoundingClientRect().width);
      const gap = Number.parseFloat(getComputedStyle(target).columnGap) || 0;
      const available = target.clientWidth;
      const menuWidth = probe.querySelector<HTMLElement>(".action-menu")?.offsetWidth ?? 0;
      const total = widths.slice(0, actions.length).reduce((sum, width) => sum + width + gap, 0);
      const needsMenu = secondary.length > 0 || total - gap > available;
      let used = needsMenu ? menuWidth + gap : 0;
      let count = 0;
      for (const width of widths.slice(0, actions.length)) {
        if (used + width > available) break;
        used += width + gap;
        count++;
      }
      visibleCount.value = count;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(target);
    observer.observe(probe);
    void document.fonts.ready.then(fit);
    fit();
    onWatcherCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);
</script>
<template>
  <div ref="row" class="context-actions">
    <UiButton
      v-for="action in actions.slice(0, visibleCount)"
      :key="action.id"
      size="sm"
      variant="ghost"
      :disabled="action.disabled"
      :title="action.title"
      :data-testid="action.testId"
      @click="action.run()"
      >{{ action.label }}</UiButton
    >
    <ActionMenu
      v-if="overflow.length"
      label="More actions"
      icon-only
      icon="ellipsis"
      size="sm"
      test-id="context-more-actions"
    >
      <button
        v-for="action in overflow"
        :key="action.id"
        type="button"
        role="menuitem"
        :disabled="action.disabled"
        :title="action.title"
        :data-testid="action.testId"
        @click="action.run()"
      >
        {{ action.label }}
      </button>
    </ActionMenu>
    <div ref="measure" class="context-actions__measure" aria-hidden="true" inert>
      <UiButton v-for="action in actions" :key="action.id" size="sm" variant="ghost">{{
        action.label
      }}</UiButton>
      <ActionMenu label="More actions" icon-only icon="ellipsis" size="sm" />
    </div>
  </div>
</template>
<style scoped>
.context-actions {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.context-actions > :deep(*) {
  flex-shrink: 0;
}
.context-actions > :deep(.action-menu) {
  margin-left: auto;
}
.context-actions :deep(.ui-btn__label) {
  overflow: visible;
  text-overflow: clip;
}
.context-actions__measure {
  position: fixed;
  top: 0;
  left: 0;
  display: flex;
  gap: var(--space-2);
  width: max-content;
  visibility: hidden;
  pointer-events: none;
}
</style>
