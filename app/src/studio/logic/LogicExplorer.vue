<script setup lang="ts">
import { computed } from "vue";
import UiChip from "../../ui/UiChip.vue";
import { documentLabel, type LogicWorkspaceDocument } from "./logicWorkspace.ts";

/**
 * The workspace's documents: every authored document in stored order, with a
 * change dot and a read-only badge on native bytes, then — when the open set
 * any aside — the refused source claims under their own review section.
 */
const { documents, activeKey, rejectedKeys } = defineProps<{
  readonly documents: readonly LogicWorkspaceDocument[];
  readonly activeKey: string | null;
  readonly rejectedKeys: readonly string[];
}>();
const emit = defineEmits<{ open: [key: string] }>();

const groups = computed(() => {
  const logics = documents.filter((doc) => doc.key.startsWith("logic:"));
  const pictures = documents.filter((doc) => doc.key.startsWith("picture:"));
  const views = documents.filter((doc) => doc.key.startsWith("view:"));
  const sounds = documents.filter((doc) => doc.key.startsWith("sound:"));
  const other = documents.filter((doc) => !/^(?:logic|picture|view|sound):/.test(doc.key));
  return [
    ["Logic", logics],
    ["Pictures", pictures],
    ["Views", views],
    ["Sounds", sounds],
    ["Project", other],
  ] as const;
});
</script>

<template>
  <nav class="logic-explorer" aria-label="Project documents" data-testid="logic-explorer">
    <template v-for="[label, list] in groups" :key="label">
      <template v-if="list.length">
        <h3 class="logic-explorer__group">{{ label }}</h3>
        <button
          v-for="doc in list"
          :key="doc.key"
          type="button"
          class="logic-explorer__item"
          :class="{ 'logic-explorer__item--active': doc.key === activeKey }"
          :data-testid="`logic-doc-${doc.key}`"
          :title="
            doc.kind === 'bytes'
              ? `${documentLabel(doc.key)}: native bytes, read-only`
              : documentLabel(doc.key)
          "
          @click="emit('open', doc.key)"
        >
          <span
            class="logic-explorer__dot"
            :class="{ 'logic-explorer__dot--dirty': doc.dirty }"
            aria-hidden="true"
          ></span>
          <span class="logic-explorer__name">{{ documentLabel(doc.key) }}</span>
          <UiChip v-if="doc.kind === 'bytes'" tone="neutral">Bytes</UiChip>
        </button>
      </template>
    </template>
    <template v-if="rejectedKeys.length">
      <h3 class="logic-explorer__group logic-explorer__group--review">Set aside for review</h3>
      <div
        v-for="key in rejectedKeys"
        :key="key"
        class="logic-explorer__item logic-explorer__item--rejected"
        :data-testid="`logic-rejected-${key}`"
      >
        <span class="logic-explorer__name">{{ key }}</span>
      </div>
    </template>
  </nav>
</template>

<style scoped>
.logic-explorer {
  overflow-y: auto;
  padding: var(--space-2);
}
.logic-explorer__group {
  margin: var(--space-3) var(--space-2) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.logic-explorer__group--review {
  color: var(--warn);
}
.logic-explorer__item {
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
.logic-explorer__item:hover {
  background: var(--surface-2);
}
.logic-explorer__item--active {
  background: var(--surface-3);
}
.logic-explorer__item--rejected {
  color: var(--warn);
  cursor: default;
}
.logic-explorer__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}
.logic-explorer__dot--dirty {
  background: var(--action);
}
.logic-explorer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
