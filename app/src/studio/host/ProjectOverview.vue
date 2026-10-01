<script setup lang="ts">
/**
 * The project frame's landing place. Pure: it names the open project and its
 * interpreter profile, counts the workspace's real documents per resource
 * family, offers the host's project actions and one concrete first step
 * derived from the actual document set. It holds no session or draft state.
 */
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import type { ProjectStudioDestination } from "../../shell/projectStudioNav.ts";
import type { LogicWorkspaceDocument } from "../logic/logicWorkspace.ts";
import {
  projectResourceSummary,
  projectStudioFirstStep,
  type ProjectStudioAction,
} from "./projectStudioDocuments.ts";

const {
  title,
  profile,
  documents,
  actions = [],
} = defineProps<{
  /** The open project's display name. */
  readonly title: string;
  /** The interpreter profile label, e.g. `AGI 2.936`. */
  readonly profile: string;
  /** Every authored document in the open workspace. */
  readonly documents: readonly LogicWorkspaceDocument[];
  /**
   * Project-level actions the host offers on this landing place. Per-editor
   * verbs — Playtest, Keep, Undo, the common close — live in the host's
   * persistent frame bar beside the tabs, not here.
   */
  readonly actions?: readonly ProjectStudioAction[];
}>();
const emit = defineEmits<{
  select: [destination: ProjectStudioDestination];
  action: [id: string];
}>();

/**
 * Single-file families — WORDS.TOK and OBJECT — name themselves without a
 * count; a number there would read as one word or one item.
 */
const UNCOUNTED = new Set(["words", "inventory"]);

const stats = computed(() => projectResourceSummary(documents));
const start = computed(() => projectStudioFirstStep(documents));
const dirtyCount = computed(() => documents.filter((doc) => doc.dirty).length);
</script>

<template>
  <section
    class="project-overview"
    aria-label="Project overview"
    data-testid="project-studio-overview"
  >
    <header class="project-overview__head">
      <h2 class="project-overview__title">{{ title }}</h2>
      <UiChip>{{ profile }}</UiChip>
    </header>

    <div class="project-overview__stats" aria-label="Resources">
      <UiChip v-for="stat in stats" :key="stat.id" :data-testid="`project-stat-${stat.id}`">
        {{ stat.label }}{{ UNCOUNTED.has(stat.id) ? "" : ` ${stat.count}`
        }}<template v-if="stat.detail !== undefined"> · {{ stat.detail }}</template>
      </UiChip>
    </div>
    <p v-if="dirtyCount > 0" class="project-overview__dirty" data-testid="project-overview-dirty">
      {{ dirtyCount }} {{ dirtyCount === 1 ? "document has" : "documents have" }} unsaved changes.
    </p>

    <div v-if="start !== undefined" class="project-overview__block">
      <h3 class="project-overview__heading">Start here</h3>
      <p class="project-overview__copy">Make a change, then playtest.</p>
      <UiButton
        variant="primary"
        size="sm"
        data-testid="project-overview-start"
        @click="emit('select', { kind: 'document', key: start!.key })"
      >
        Open {{ start.label }}
      </UiButton>
    </div>

    <div v-if="actions.length" class="project-overview__block">
      <h3 class="project-overview__heading">Actions</h3>
      <div v-for="action in actions" :key="action.id" class="project-overview__action">
        <UiButton
          size="sm"
          :disabled="action.unavailableReason !== undefined"
          :aria-describedby="
            action.unavailableReason !== undefined || action.hint !== undefined
              ? `project-action-note-${action.id}`
              : undefined
          "
          :data-testid="`project-action-${action.id}`"
          @click="emit('action', action.id)"
        >
          {{ action.label }}
        </UiButton>
        <p
          v-if="action.unavailableReason !== undefined || action.hint !== undefined"
          :id="`project-action-note-${action.id}`"
          class="project-overview__hint"
          :data-testid="`project-action-note-${action.id}`"
        >
          {{ action.unavailableReason ?? action.hint }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.project-overview {
  overflow-y: auto;
  padding: var(--space-7) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.project-overview__head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.project-overview__title {
  margin: 0;
  font: var(--weight-bold) var(--text-2xl) / var(--leading-tight) var(--font-sans);
  color: var(--ink);
}
.project-overview__stats {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.project-overview__dirty {
  margin: 0;
  color: var(--ink-2);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.project-overview__block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.project-overview__heading {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.project-overview__copy {
  margin: 0;
  color: var(--ink-2);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.project-overview__action {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.project-overview__hint {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
</style>
