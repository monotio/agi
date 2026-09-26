<script setup lang="ts">
/**
 * One Create dock: a tab strip over the registered panels for its side and
 * the active panel's body. Panels without a component show an empty
 * placeholder, except `builtIn` ids, whose body the parent draws below the
 * dock (the assistant stays mounted across modes). Folded, the dock is an
 * icon rail: each icon opens its panel. The phone's `sheet` gathers World,
 * Assistant and Inspect into one bottom sheet.
 */
import { computed, useId } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { createPanels, type CreatePanel, type DockSide } from "./createDocks.ts";

const {
  side,
  readOnly,
  builtIn = [],
  collapsed = false,
} = defineProps<{
  side: DockSide | "sheet";
  readOnly: boolean;
  builtIn?: readonly string[];
  collapsed?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const active = defineModel<string>("active", { required: true });

const SHEET_PANELS = ["world", "assistant", "inspect"];

const panels = computed<CreatePanel[]>(() =>
  side === "sheet"
    ? SHEET_PANELS.flatMap((id) =>
        [...createPanels("left"), ...createPanels("right")].filter((panel) => panel.id === id),
      )
    : createPanels(side),
);
const current = computed(
  () => panels.value.find((panel) => panel.id === active.value) ?? panels.value[0],
);
const tabsId = useId();
const label = computed(() =>
  side === "left" ? "World panels" : side === "right" ? "Assistant panels" : "Create panels",
);
const key = side === "left" ? "[" : "]";
/** A folded side dock is an icon rail; a folded sheet keeps its labelled tabs. */
const rail = computed(() => collapsed && side !== "sheet");

function select(id: string): void {
  active.value = id;
  if (collapsed) emit("toggle");
}

/** Arrow keys move along the strip (Up/Down on the rail), Home/End jump. */
function onTabKey(ev: KeyboardEvent): void {
  const list = panels.value;
  const index = list.findIndex((panel) => panel.id === current.value?.id);
  const forward = rail.value ? "ArrowDown" : "ArrowRight";
  const back = rail.value ? "ArrowUp" : "ArrowLeft";
  let next: number;
  if (ev.key === forward) next = (index + 1) % list.length;
  else if (ev.key === back) next = (index - 1 + list.length) % list.length;
  else if (ev.key === "Home") next = 0;
  else if (ev.key === "End") next = list.length - 1;
  else return;
  ev.preventDefault();
  const panel = list[next];
  if (!panel) return;
  active.value = panel.id;
  (ev.currentTarget as HTMLElement)
    .querySelector<HTMLElement>(`[data-testid="dock-tab-${panel.id}"]`)
    ?.focus();
}
</script>

<template>
  <div
    class="create-dock"
    :class="[`create-dock--${side}`, { 'create-dock--rail': rail }]"
    :data-testid="`create-dock-${side}`"
  >
    <div class="create-dock__head">
      <div
        class="create-dock__tabs"
        role="tablist"
        :aria-label="label"
        :aria-orientation="rail ? 'vertical' : 'horizontal'"
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
          :aria-controls="collapsed ? undefined : `${tabsId}-${panel.id}-panel`"
          :aria-label="rail ? panel.title : undefined"
          :title="rail ? panel.title : undefined"
          :tabindex="panel.id === current?.id ? 0 : -1"
          :data-testid="`dock-tab-${panel.id}`"
          @click="select(panel.id)"
        >
          <UiIcon v-if="panel.icon" :name="panel.icon" :size="16" /><span
            v-if="!rail"
            class="create-dock__tab-label"
            >{{ panel.title }}</span
          >
        </button>
      </div>
      <UiIconButton
        class="create-dock__fold"
        :icon="
          side === 'sheet'
            ? collapsed
              ? 'chevron-up'
              : 'chevron-down'
            : side === 'left'
              ? 'panel-left'
              : 'panel-right'
        "
        :label="collapsed ? `Show ${label.toLowerCase()}` : `Fold ${label.toLowerCase()}`"
        :shortcut="side === 'sheet' ? undefined : key"
        size="sm"
        :aria-expanded="!collapsed"
        :data-testid="`dock-fold-${side}`"
        @click="emit('toggle')"
      />
    </div>
    <div
      v-if="!collapsed && current && (current.component || !builtIn.includes(current.id))"
      :id="`${tabsId}-${current.id}-panel`"
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
.create-dock__head {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.create-dock--right .create-dock__head {
  flex-direction: row-reverse;
  padding: var(--space-3) var(--space-3) 0 var(--space-2);
}
.create-dock__tabs {
  display: flex;
  flex: 1;
  gap: var(--space-0);
  min-width: 0;
}
.create-dock__fold {
  margin-bottom: var(--space-1);
  color: var(--ink-3);
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
  white-space: nowrap;
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

/* The rail: the fold control on top, one icon per panel under it. */
.create-dock--rail {
  align-items: center;
}
.create-dock--rail .create-dock__head,
.create-dock--rail.create-dock--right .create-dock__head {
  flex-direction: column-reverse;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 0;
}
.create-dock--rail .create-dock__tabs {
  flex: none;
  flex-direction: column;
  gap: var(--space-1);
}
.create-dock--rail .create-dock__tab {
  justify-content: center;
  width: var(--control-h);
  min-height: var(--control-h);
  padding: 0;
  border-bottom: 0;
  border-radius: var(--radius);
}
.create-dock--rail .create-dock__tab[aria-selected="true"] {
  color: var(--action);
  background: var(--action-soft);
}
.create-dock--rail .create-dock__fold {
  margin: 0;
}

/* The phone's sheet: tabs share the width at touch size. */
.create-dock--sheet .create-dock__head {
  padding: var(--space-2) var(--space-3) 0;
}
.create-dock--sheet .create-dock__tab {
  flex: 1;
  justify-content: center;
  min-height: var(--control-h-touch);
}
</style>
