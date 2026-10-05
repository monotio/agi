<script setup lang="ts">
/**
 * The project frame's open-document tabs. Pure: the host supplies the tab
 * rows (projectStudioDocuments.ts `projectStudioTabs` output) and the
 * selected key; the component reports `select` and `close` requests. `close`
 * names the tab to hide — the host decides what that means for the document
 * surface, and it never implies Keep, deletion or draft mutation. A tab
 * whose key left the document set stays listed, marked missing.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import UiChip from "../../ui/UiChip.vue";
import type { ProjectStudioTab } from "./projectStudioDocuments.ts";

const {
  tabs,
  selectedKey = null,
  pending = false,
} = defineProps<{
  readonly pending?: boolean;
  /** The open document rows, in the host's tab order. */
  readonly tabs: readonly ProjectStudioTab[];
  /** The selected document key, or null on the overview. */
  readonly selectedKey?: string | null;
}>();
const emit = defineEmits<{
  select: [key: string];
  close: [key: string];
  pin: [key: string];
}>();

const root = useTemplateRef("root");
/** The tab keyboard focus roves on; the close buttons stay out of it. */
const focusKey = ref<string>();
/** Whether focus currently lives inside the strip (set by focusin/focusout). */
const focusWithin = ref(false);

const rovingKey = computed<string | undefined>(() => {
  if (focusKey.value !== undefined && tabs.some((tab) => tab.key === focusKey.value))
    return focusKey.value;
  if (selectedKey !== null && tabs.some((tab) => tab.key === selectedKey)) return selectedKey;
  return tabs[0]?.key;
});

function tabElement(key: string): HTMLElement | undefined {
  return root.value?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`) ?? undefined;
}

/**
 * Roving focus: the strip is one tab stop; Arrow keys and Home/End move
 * between tab names, Enter or a click selects, and Delete on the focused
 * tab asks to close it. A re-rendered or shortened list keeps focus on the
 * surviving row — see the watch below for removal.
 */
function onKeydown(event: KeyboardEvent): void {
  const keys = tabs.map((tab) => tab.key);
  const from = keys.indexOf((event.target as HTMLElement).dataset["tabKey"] ?? "");
  const index = from >= 0 ? from : keys.indexOf(rovingKey.value ?? "");
  if (event.key === "Delete") {
    const key = keys[index];
    if (key !== undefined) {
      event.preventDefault();
      emit("close", key);
    }
    return;
  }
  let next: number | undefined;
  if (event.key === "ArrowRight") next = Math.min(index + 1, keys.length - 1);
  else if (event.key === "ArrowLeft") next = Math.max(index - 1, 0);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = keys.length - 1;
  else return;
  event.preventDefault();
  const key = keys[next];
  if (key !== undefined) tabElement(key)?.focus();
}

function onFocusout(event: FocusEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) focusWithin.value = false;
}

// A list update that removes the focused tab lands focus on the row that
// took its slot — only while the strip held focus, so a background update
// never steals it.
watch(
  () => tabs,
  (next: readonly ProjectStudioTab[], prev: readonly ProjectStudioTab[]) => {
    const focused = focusKey.value;
    if (!focusWithin.value || focused === undefined || next.some((tab) => tab.key === focused))
      return;
    const slot = Math.min(
      Math.max(
        prev.findIndex((tab) => tab.key === focused),
        0,
      ),
      next.length - 1,
    );
    const key = next[slot]?.key;
    focusKey.value = key;
    void nextTick(() => {
      if (key !== undefined) tabElement(key)?.focus();
    });
  },
);

watch(
  () => [selectedKey, tabs],
  () => {
    void nextTick(() => {
      if (selectedKey === null) return;
      const button = tabElement(selectedKey);
      const strip = root.value;
      if (!button || !strip) return;
      const tab = button.parentElement!;
      if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth)
        strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    });
  },
  { immediate: true },
);

function tabLabel(tab: ProjectStudioTab): string {
  const base = tab.name ?? tab.label;
  const state = `${tab.missing && !tab.dirty ? ", missing" : ""}${tab.dirty ? (pending ? ", pending change" : ", unsaved changes") : ""}`;
  return `${base}${state}`;
}
</script>

<template>
  <div
    ref="root"
    class="project-tabs"
    role="tablist"
    aria-label="Open documents"
    data-testid="project-studio-tabs"
    @keydown="onKeydown"
    @focusin="focusWithin = true"
    @focusout="onFocusout"
  >
    <div
      v-for="tab in tabs"
      :key="tab.key"
      role="presentation"
      class="project-tabs__tab"
      :class="{
        'project-tabs__tab--active': tab.key === selectedKey,
        'project-tabs__tab--missing': tab.missing,
      }"
    >
      <button
        type="button"
        role="tab"
        class="project-tabs__name"
        :aria-selected="tab.key === selectedKey"
        :class="{ 'project-tabs__name--preview': tab.preview }"
        :aria-label="tabLabel(tab)"
        aria-keyshortcuts="Delete"
        :tabindex="rovingKey === tab.key ? 0 : -1"
        :data-tab-key="tab.key"
        :data-testid="`project-tab-${tab.key}`"
        :title="tab.name !== undefined ? `${tab.label}: ${tab.name}` : tab.label"
        @click="emit('select', tab.key)"
        @dblclick="emit('pin', tab.key)"
        @focus="focusKey = tab.key"
      >
        <span
          class="project-tabs__dot"
          :class="{ 'project-tabs__dot--dirty': tab.dirty }"
          :aria-hidden="!pending || !tab.dirty"
          :aria-label="pending && tab.dirty ? 'Pending change' : undefined"
        ></span>
        <span class="project-tabs__text">{{ tab.name ?? tab.label }}</span>
        <UiChip v-if="tab.missing" tone="warn">{{
          tab.dirty ? (pending ? "Draft" : "Not saved") : "Missing"
        }}</UiChip>
      </button>
      <button
        type="button"
        class="project-tabs__close"
        :aria-label="`Close ${tab.name ?? tab.label}`"
        :data-testid="`project-tab-close-${tab.key}`"
        tabindex="-1"
        @click="emit('close', tab.key)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.project-tabs {
  position: relative;
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  min-height: var(--control-h-sm);
}
.project-tabs__tab {
  display: flex;
  align-items: center;
  flex: none;
  max-width: 220px;
  border-right: 1px solid var(--hairline);
}
.project-tabs__tab--active {
  background: var(--surface-2);
  box-shadow: inset 0 2px 0 var(--action);
}
.project-tabs__tab--missing {
  opacity: 0.75;
}
.project-tabs__name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0 var(--space-1) 0 var(--space-3);
  border: 0;
  color: var(--ink-2);
  background: transparent;
  font: var(--text-sm) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.project-tabs__name--preview {
  font-style: italic;
}
.project-tabs__tab--active .project-tabs__name {
  color: var(--ink);
}
.project-tabs__name:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.project-tabs__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}
.project-tabs__dot--dirty {
  background: var(--action);
}
.project-tabs__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-tabs__close {
  flex: none;
  padding: 0 var(--space-2);
  border: 0;
  color: var(--ink-3);
  background: transparent;
  font: var(--text-md) / 1 var(--font-sans);
  cursor: pointer;
}
.project-tabs__close:hover {
  color: var(--ink);
}
.project-tabs__close:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
</style>
