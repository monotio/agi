<script setup lang="ts">
/**
 * Create a game locally: the default way to start a new game without an AI
 * connection or a running worker. A title plus a selected manual seed is
 * committed straight to browser storage; `created` carries the durable project
 * identity so the parent can navigate and boot. A failed save keeps the
 * prepared candidate, so resubmitting with unchanged seed inputs retries the
 * same commit rather than minting another game. A landed save keeps it too:
 * resubmitting while the parent still navigates re-emits the stored project.
 */
import { defineAsyncComponent, onMounted, ref, useTemplateRef, watch } from "vue";
import { createNewGameChoice, NEW_GAME_CHOICES, type NewGameChoice } from "./newGameChoice.ts";
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import type { StarterKind } from "../../../src/authoring/starterProject.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import type { prepareLocalProject } from "../project/localProject.ts";

const {
  aiReady,
  aiUnavailable,
  aiValid,
  initialChoice = undefined,
} = defineProps<{
  aiReady: boolean;
  aiUnavailable: boolean;
  aiValid: boolean;
  initialChoice?: NewGameChoice | undefined;
}>();
const emit = defineEmits<{
  created: [projectId: ProjectId, kind: StarterKind];
  ai: [title: string];
  choice: [value: NewGameChoice];
  connect: [event: MouseEvent];
}>();
const TemplatePicture = defineAsyncComponent(() => import("./TemplatePicture.vue"));

const TITLE_MAX = 160;
type PreparedProject = ReturnType<typeof prepareLocalProject>;

const title = ref("My adventure");
const choice = createNewGameChoice(initialChoice);
const { selected: kind, aiVisible } = choice;
watch(kind, (value) => {
  if (value) emit("choice", value);
});
const saving = ref(false);
const titleError = ref("");
const error = ref("");
const warning = ref("");

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
  if (saving.value || !kind.value) return;
  const name = title.value.trim();
  if (!name) {
    titleError.value = "Enter a game title.";
    titleInput.value?.focus();
    return;
  }
  if (kind.value === "ai") {
    emit("ai", name);
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
    emit("created", prepared.candidate.projectId, prepared.kind);
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

function onChoiceKey(event: KeyboardEvent, value: NewGameChoice): void {
  const next = choice.key(value, event.key);
  if (!next) return;
  event.preventDefault();
  const group = (event.currentTarget as HTMLElement).parentElement;
  group?.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
}
onMounted(focus);
defineExpose({ focus, select: choice.select });
</script>

<template>
  <form class="local-create" data-testid="local-create-form" @submit.prevent="createGame">
    <UiField
      v-slot="{ id, describedBy, invalid }"
      label="Name"
      class="namefield"
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
    <div class="templates" role="radiogroup" aria-label="Starting point">
      <button
        v-for="option in NEW_GAME_CHOICES"
        :key="option.value"
        type="button"
        role="radio"
        class="tpl"
        :class="{ 'tpl-ai': option.value === 'ai' }"
        :aria-checked="kind === option.value"
        :tabindex="kind === option.value || (!kind && option.value === 'starter') ? 0 : -1"
        :disabled="saving"
        :data-choice="option.value"
        :data-testid="`local-create-kind-${option.value}`"
        @click="choice.select(option.value)"
        @keydown="onChoiceKey($event, option.value)"
      >
        <TemplatePicture v-if="option.value !== 'ai'" :kind="option.value" />
        <span v-else class="ai-art" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 16 16">
            <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z" />
          </svg>
          <svg class="spark2" width="16" height="16" viewBox="0 0 16 16">
            <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z" />
          </svg>
        </span>
        <span class="tpl-b"
          ><strong>{{ option.title }}</strong
          ><span>{{ option.description }}</span></span
        >
      </button>
    </div>
    <slot v-if="aiVisible" name="ai" />
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
    <div v-if="kind" class="start-row">
      <UiButton
        type="submit"
        variant="primary"
        :disabled="saving || (aiVisible && (!aiReady || !aiValid))"
        :data-testid="aiVisible ? 'boot-game' : 'local-create-submit'"
      >
        {{ saving ? "Creating…" : aiVisible ? "Create with AI" : "Start building" }}
      </UiButton>
      <template v-if="aiVisible && !aiReady">
        <span class="note" data-testid="create-ai-connect"
          >Needs an AI key. Connect one in Settings.</span
        >
        <UiButton
          :disabled="aiUnavailable"
          data-testid="connect-create-ai"
          @click="emit('connect', $event)"
          >Connect</UiButton
        >
      </template>
    </div>
  </form>
</template>

<style scoped>
.local-create {
  display: grid;
  gap: var(--space-7);
}
.namefield {
  max-width: 420px;
}
.namefield input {
  min-height: var(--control-h-touch);
  background: var(--surface-1);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
}
.templates {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-5);
}
.tpl {
  padding: 0;
  align-content: start;
  text-align: left;
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  color: var(--ink);
  font: inherit;
  overflow: hidden;
  display: grid;
  cursor: pointer;
  transition:
    border-color var(--duration) var(--ease-out),
    transform var(--duration) var(--ease-out);
}
.tpl:hover {
  border-color: var(--hairline-strong);
  transform: translateY(-2px);
}
.tpl[aria-checked="true"] {
  border-color: var(--action);
  box-shadow: 0 0 0 1px var(--action);
}
.tpl-b {
  padding: var(--space-4) var(--space-5) var(--space-5);
  display: grid;
  gap: var(--space-0);
}
.tpl-b strong {
  font-size: var(--text-md);
}
.tpl-b span {
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.tpl-ai {
  background: linear-gradient(160deg, var(--surface-2), var(--surface-1));
}
.ai-art {
  aspect-ratio: 320 / 168;
  display: grid;
  place-items: center;
  position: relative;
  border-bottom: 1px solid var(--hairline);
}
.ai-art {
  background: radial-gradient(circle at 50% 55%, var(--action-soft), transparent 60%);
}
.ai-art svg {
  fill: var(--action);
}
.spark2 {
  position: absolute;
  left: 60%;
  top: 26%;
  opacity: 0.6;
}
.start-row {
  display: flex;
  gap: var(--space-4);
  align-items: center;
}
.note {
  color: var(--ink-2);
  font-size: var(--text-sm);
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
@media (max-width: 760px) {
  .templates {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .start-row {
    flex-wrap: wrap;
  }
}
@media (max-width: 520px) {
  .templates {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
