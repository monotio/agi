<script setup lang="ts">
/**
 * One Create dock: a tab strip over the registered panels for its side and
 * the active panel's body. Panels without a component show an empty
 * placeholder, except `builtIn` ids, whose body the parent draws below the
 * dock (the assistant stays mounted across modes).
 */
import { computed, useId } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import { createPanels, type DockSide } from "./createDocks.ts";

const {
  side,
  readOnly,
  builtIn = [],
} = defineProps<{
  side: DockSide;
  readOnly: boolean;
  builtIn?: readonly string[];
}>();
const active = defineModel<string>("active", { required: true });

const panels = computed(() => createPanels(side));
const current = computed(
  () => panels.value.find((panel) => panel.id === active.value) ?? panels.value[0],
);
const tabsId = useId();

function onTabKey(ev: KeyboardEvent): void {
  const list = panels.value;
  const index = list.findIndex((panel) => panel.id === current.value?.id);
  const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
  if (!step || list.length < 2) return;
  ev.preventDefault();
  const next = list[(index + step + list.length) % list.length]!;
  active.value = next.id;
  (ev.currentTarget as HTMLElement)
    .querySelector<HTMLElement>(`[data-testid="dock-tab-${next.id}"]`)
    ?.focus();
}
</script>

<template>
  <div class="create-dock" :data-testid="`create-dock-${side}`">
    <div
      class="create-dock__tabs"
      role="tablist"
      :aria-label="side === 'left' ? 'World panels' : 'Assistant panels'"
      @keydown="onTabKey"
    >
      <button
        v-for="panel in panels"
        :id="`${tabsId}-${panel.id}`"
        :key="panel.id"
        type="button"
        role="tab"
        class="create-dock__tab"
        :aria-selected="panel.id === current?.id"
        :tabindex="panel.id === current?.id ? 0 : -1"
        :data-testid="`dock-tab-${panel.id}`"
        @click="active = panel.id"
      >
        <UiIcon v-if="panel.icon" :name="panel.icon" :size="16" />{{ panel.title }}
      </button>
    </div>
    <div
      v-if="current && (current.component || !builtIn.includes(current.id))"
      class="create-dock__body"
      role="tabpanel"
      :aria-labelledby="`${tabsId}-${current.id}`"
      :data-testid="`dock-panel-${current.id}`"
    >
      <component :is="current.component" v-if="current.component" :read-only="readOnly" />
      <slot v-else :name="current.id">
        <p class="create-dock__empty">{{ current.title }} docks here in Create mode.</p>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.create-dock {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.create-dock__tabs {
  display: flex;
  gap: var(--space-0);
  padding: var(--space-3) var(--space-3) 0;
  border-bottom: 1px solid var(--hairline);
}
.create-dock__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h);
  padding: 0 var(--space-4);
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--ink-3);
  background: none;
  font: var(--weight-semibold) var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.create-dock__tab:hover {
  color: var(--ink-2);
}
.create-dock__tab[aria-selected="true"] {
  color: var(--ink);
  border-bottom-color: var(--action);
}
.create-dock__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-5);
}
.create-dock__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
}
</style>
