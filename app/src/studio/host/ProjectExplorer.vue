<script setup lang="ts">
/**
 * The project frame's resource selector. Pure: the host supplies the current
 * document list (logicWorkspace.ts `workspaceDocuments` output) and the
 * selected destination; the component renders the six canonical resource
 * sections and emits the destination a click asks for. It holds no session,
 * no draft and no tab state — closing and retaining documents is the host's.
 */
import { computed, ref, useTemplateRef } from "vue";
import type { ProjectStudioDestination } from "../../shell/projectStudioNav.ts";
import { documentLabel, type LogicWorkspaceDocument } from "../logic/logicWorkspace.ts";
import {
  projectDocumentEntry,
  projectExplorerSections,
  type ProjectDocumentItem,
} from "./projectStudioDocuments.ts";

const {
  documents,
  destination,
  rejectedKeys = [],
} = defineProps<{
  /** Every authored document in the open workspace, in stored order. */
  readonly documents: readonly LogicWorkspaceDocument[];
  /** The frame's current place: overview or a document key. */
  readonly destination: ProjectStudioDestination;
  /** Refused source claims under review, listed by document key. */
  readonly rejectedKeys?: readonly string[];
}>();
const emit = defineEmits<{ select: [destination: ProjectStudioDestination] }>();

const sections = computed(() => projectExplorerSections(documents));

/** The overview row's slot in the roving order (no document key collides). */
const OVERVIEW_ROW = "overview";

/**
 * The needs-review rows: refused source claims listed by document key. Each
 * row roves on its own identifier — `rejected:<key>` — so a rejected key
 * that also exists as a normal family row never produces two tab stops for
 * one identity. The label is the canonical document label plus the bound
 * name when the document set has one.
 */
const rejected = computed(() =>
  rejectedKeys.map((key) => {
    const item = projectDocumentEntry(documents, key);
    return {
      key,
      row: `rejected:${key}`,
      label: item?.label ?? documentLabel(key),
      ...(item?.name !== undefined ? { name: item.name } : {}),
    };
  }),
);

const root = useTemplateRef("root");
/** The row keyboard focus roves on; follows the DOM, survives reorders. */
const focusRow = ref<string>();

const rovingRow = computed<string>(() => {
  const rows = new Set([OVERVIEW_ROW]);
  for (const section of sections.value)
    for (const group of section.groups) for (const item of group.entries) rows.add(item.key);
  for (const row of rejected.value) rows.add(row.row);
  if (focusRow.value !== undefined && rows.has(focusRow.value)) return focusRow.value;
  if (destination.kind === "document" && rows.has(destination.key)) return destination.key;
  return OVERVIEW_ROW;
});

/** The keyboard rows in display order: overview first, then every entry. */
function focusable(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>("[data-explorer-item]") ?? [])];
}

/**
 * Roving focus: the list is one tab stop; Arrow keys and Home/End move
 * between the overview entry and document rows. Focus lives on the real
 * buttons, so a re-rendered list keeps it on whichever row survives.
 */
function onKeydown(event: KeyboardEvent): void {
  const items = focusable();
  const index = items.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  let next: number | undefined;
  if (event.key === "ArrowDown") next = Math.min(index + 1, items.length - 1);
  else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  items[next]?.focus();
}

function itemTitle(item: ProjectDocumentItem): string {
  return item.name !== undefined ? `${item.label}: ${item.name}` : item.label;
}
</script>

<template>
  <nav
    ref="root"
    class="project-explorer"
    aria-label="Project resources"
    data-testid="project-studio-explorer"
    @keydown="onKeydown"
  >
    <button
      type="button"
      class="project-explorer__item project-explorer__item--overview"
      :class="{ 'project-explorer__item--active': destination.kind === 'overview' }"
      :aria-current="destination.kind === 'overview' ? 'true' : undefined"
      :tabindex="rovingRow === OVERVIEW_ROW ? 0 : -1"
      data-explorer-item
      data-testid="project-studio-explorer-overview"
      @click="emit('select', { kind: 'overview' })"
      @focus="focusRow = OVERVIEW_ROW"
    >
      <span class="project-explorer__name">Overview</span>
    </button>
    <template v-for="section in sections" :key="section.id">
      <h3 class="project-explorer__section">{{ section.label }}</h3>
      <template v-for="(group, groupIndex) in section.groups" :key="groupIndex">
        <h4 v-if="group.label !== undefined" class="project-explorer__group">{{ group.label }}</h4>
        <button
          v-for="item in group.entries"
          :key="item.key"
          type="button"
          class="project-explorer__item"
          :class="{
            'project-explorer__item--active':
              destination.kind === 'document' && destination.key === item.key,
          }"
          :aria-current="
            destination.kind === 'document' && destination.key === item.key ? 'true' : undefined
          "
          :tabindex="rovingRow === item.key ? 0 : -1"
          :title="itemTitle(item)"
          :data-testid="`project-doc-${item.key}`"
          data-explorer-item
          @click="emit('select', { kind: 'document', key: item.key })"
          @focus="focusRow = item.key"
        >
          <span
            class="project-explorer__dot"
            :class="{ 'project-explorer__dot--dirty': item.dirty }"
            aria-hidden="true"
          ></span>
          <span class="project-explorer__name">{{ item.name ?? item.label }}</span>
          <span v-if="item.name !== undefined" class="project-explorer__detail">{{
            item.label
          }}</span>
        </button>
      </template>
    </template>
    <template v-if="rejected.length">
      <h3 class="project-explorer__section project-explorer__section--review">Needs review</h3>
      <button
        v-for="item in rejected"
        :key="item.row"
        type="button"
        class="project-explorer__item project-explorer__item--rejected"
        :class="{
          'project-explorer__item--active':
            destination.kind === 'document' && destination.key === item.key,
        }"
        :aria-current="
          destination.kind === 'document' && destination.key === item.key ? 'true' : undefined
        "
        :tabindex="rovingRow === item.row ? 0 : -1"
        :title="item.name !== undefined ? `${item.label}: ${item.name}` : item.label"
        :data-testid="`project-rejected-${item.key}`"
        data-explorer-item
        @click="emit('select', { kind: 'document', key: item.key })"
        @focus="focusRow = item.row"
      >
        <span class="project-explorer__name">{{ item.name ?? item.label }}</span>
        <span v-if="item.name !== undefined" class="project-explorer__detail">{{
          item.label
        }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.project-explorer {
  overflow-y: auto;
  padding: var(--space-2);
}
.project-explorer__section {
  margin: var(--space-3) var(--space-2) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.project-explorer__section--review {
  color: var(--warn);
}
.project-explorer__group {
  margin: var(--space-2) var(--space-2) var(--space-0);
  color: var(--ink-3);
  font: var(--weight-medium) var(--text-xs) / var(--leading) var(--font-sans);
}
.project-explorer__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: transparent;
  font: var(--text-sm) / var(--leading) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.project-explorer__item:hover {
  background: var(--surface-2);
}
.project-explorer__item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.project-explorer__item--active {
  background: var(--surface-3);
}
.project-explorer__item--overview {
  margin-bottom: var(--space-2);
}
.project-explorer__item--rejected {
  color: var(--warn);
}
.project-explorer__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}
.project-explorer__dot--dirty {
  background: var(--action);
}
.project-explorer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-explorer__detail {
  flex: none;
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-mono);
}
</style>
