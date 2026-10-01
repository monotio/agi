<script setup lang="ts">
/**
 * Create a game locally: the default way to start a new game without an AI
 * connection or a running worker. A title plus the Starter or Blank seed is
 * committed straight to browser storage; `created` carries the durable project
 * identity so the parent can navigate and boot. A failed save keeps the
 * prepared candidate, so resubmitting with unchanged seed inputs retries the
 * same commit rather than minting another game. A landed save keeps it too:
 * resubmitting while the parent still navigates re-emits the stored project.
 */
import { ref, useId, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import type { StarterKind } from "../../../src/authoring/starterProject.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import type { prepareLocalProject } from "../project/localProject.ts";

const emit = defineEmits<{ created: [projectId: ProjectId] }>();

const TITLE_MAX = 160;
const KIND_OPTIONS: readonly { value: StarterKind; title: string; description: string }[] = [
  {
    value: "starter",
    title: "Starter",
    description: "A playable room with a hero, menus and saving.",
  },
  {
    value: "blank",
    title: "Blank",
    description: "An empty room to build on.",
  },
];

type PreparedProject = ReturnType<typeof prepareLocalProject>;

const title = ref("My adventure");
const kind = ref<StarterKind>("starter");
const saving = ref(false);
const titleError = ref("");
const error = ref("");
const warning = ref("");
const kindGroup = useId();
const titleInput = useTemplateRef("titleInput");

/**
 * The candidate plus the inputs it was prepared from. `saved` marks a commit
 * that already landed: resubmitting the unchanged form re-emits its project
 * instead of minting another while the parent is still navigating to it.
 */
let prepared:
  { title: string; kind: StarterKind; candidate: PreparedProject; saved: boolean } | undefined;

watch(title, () => {
  titleError.value = "";
});

async function createGame(): Promise<void> {
  if (saving.value) return;
  const name = title.value.trim();
  if (!name) {
    titleError.value = "Enter a game title.";
    titleInput.value?.focus();
    return;
  }
  saving.value = true;
  error.value = "";
  warning.value = "";
  try {
    if (!prepared || prepared.title !== name || prepared.kind !== kind.value) {
      // The seed compiler stays off the Play boot path: it loads on first
      // submit. A changed seed is safe to prepare again: only the initial
      // seed exists, no editable work yet.
      const { prepareLocalProject } = await import("../project/localProject.ts");
      prepared = {
        title: name,
        kind: kind.value,
        candidate: prepareLocalProject({ title: name, kind: kind.value }),
        saved: false,
      };
    }
    if (!prepared.saved) {
      const result = await prepared.candidate.save();
      prepared.saved = true;
      warning.value = result.warnings.includes("indexRepairPending")
        ? "Saved. The game list may be out of date until its index is repaired."
        : "";
    }
    emit("created", prepared.candidate.projectId);
  } catch (reason) {
    const detail = String(reason)
      .replace(/^Error: /, "")
      .replace(/\.+$/, "");
    error.value = detail
      ? `Could not save the game: ${detail}. Try again.`
      : "Could not save the game. Try again.";
  } finally {
    saving.value = false;
  }
}

function focus(): void {
  titleInput.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <form class="local-create" data-testid="local-create-form" @submit.prevent="createGame">
    <UiField
      v-slot="{ id, describedBy, invalid }"
      label="Game title"
      :error="titleError || undefined"
    >
      <input
        :id
        ref="titleInput"
        v-model="title"
        :aria-describedby="describedBy"
        :aria-invalid="invalid || undefined"
        :maxlength="TITLE_MAX"
        :disabled="saving"
        required
        autocomplete="off"
        data-testid="local-create-title"
      />
    </UiField>
    <fieldset class="local-create__kinds" :disabled="saving">
      <legend class="local-create__legend">Starting point</legend>
      <div class="kind-grid">
        <label
          v-for="option in KIND_OPTIONS"
          :key="option.value"
          class="kind-card"
          :class="{ selected: kind === option.value }"
        >
          <input
            v-model="kind"
            type="radio"
            class="kind-card__radio"
            :name="kindGroup"
            :value="option.value"
            :data-testid="`local-create-kind-${option.value}`"
          />
          <span class="kind-card__body">
            <span class="kind-card__title">{{ option.title }}</span>
            <span class="kind-card__desc">{{ option.description }}</span>
          </span>
        </label>
      </div>
    </fieldset>
    <p
      v-if="warning"
      class="local-create__warning"
      role="status"
      data-testid="local-create-warning"
    >
      {{ warning }}
    </p>
    <p v-if="error" class="local-create__error" role="alert" data-testid="local-create-error">
      {{ error }}
    </p>
    <div class="local-create__actions">
      <UiButton
        type="submit"
        variant="primary"
        :disabled="saving"
        data-testid="local-create-submit"
      >
        {{ saving ? "Creating…" : "Create game" }}
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.local-create {
  display: grid;
  gap: var(--space-5);
}
.local-create__kinds {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.local-create__legend {
  margin: 0 0 var(--space-2);
  padding: 0;
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-sm) / var(--leading-tight) var(--font-sans);
}
.local-create__kinds:disabled .kind-card {
  cursor: default;
}
.kind-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
.kind-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: inherit;
  background: var(--surface-2);
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}
.kind-card:hover {
  border-color: var(--hairline-strong);
  background: var(--surface-3);
}
.kind-card.selected {
  border-color: var(--action);
  background: var(--action-soft);
}
.kind-card:focus-within {
  border-color: var(--action);
}
.kind-card__radio {
  margin: var(--space-1) 0 0;
  accent-color: var(--action);
}
.kind-card__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.kind-card__title {
  color: var(--ink);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.kind-card__desc {
  color: var(--ink-2);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.local-create__warning {
  margin: 0;
  color: var(--warn);
  font-size: var(--text-sm);
}
.local-create__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
.local-create__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
@media (max-width: 520px) {
  .kind-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
