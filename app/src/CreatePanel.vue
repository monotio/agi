<script setup lang="ts">
/**
 * The create-adventure disclosure: the template grid, the shared adventure
 * brief editor, the AI-connect prompt and the launch button. It registers
 * `openCreateSection` and the create button's element on the shell bridge so
 * the header and the AI settings flow can reach them.
 */
import { computed, nextTick, ref, useTemplateRef } from "vue";
import UiButton from "./ui/UiButton.vue";
import { BUILTIN_TEMPLATES } from "./gameTemplates.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";

const { aiConfigured, aiSettingsUnavailable, openAiSettings } = useAiSettings();
const { selectedTemplateId, adventureDraft, savedGames, pendingAutosave, onBootSelectedTemplate } =
  useGameLibrary();
const bridge = useShellBridge();

const createDetails = useTemplateRef("createDetails");
const createSummary = useTemplateRef("createSummary");
const createButton = useTemplateRef("createButton");
const CREATE_SECTION_KEY = "monotio_agi.createAdventure";
let storedCreatePreference: "open" | "closed" | null = null;
try {
  const stored = localStorage.getItem(CREATE_SECTION_KEY);
  if (stored === "open" || stored === "closed") storedCreatePreference = stored;
} catch {
  /* A blocked store leaves the section on its context-sensitive default. */
}
const createPreference = ref<"open" | "closed" | null>(storedCreatePreference);
const createOpen = computed(() =>
  createPreference.value === "open"
    ? true
    : createPreference.value === "closed"
      ? false
      : savedGames.value.length === 0 && pendingAutosave.value === undefined,
);

function saveCreatePreference(open: boolean): void {
  createPreference.value = open ? "open" : "closed";
  try {
    localStorage.setItem(CREATE_SECTION_KEY, createPreference.value);
  } catch {
    /* The live choice still applies when persistence is unavailable. */
  }
}

function onCreateSummaryActivate(): void {
  const opening = !createDetails.value?.open;
  saveCreatePreference(opening);
  if (!opening && location.hash === "#create-adventure")
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

async function openCreateSection(updateHash = true): Promise<void> {
  saveCreatePreference(true);
  if (createDetails.value) createDetails.value.open = true;
  if (updateHash && location.hash !== "#create-adventure")
    history.pushState(null, "", "#create-adventure");
  await nextTick();
  createSummary.value?.focus({ preventScroll: true });
  createDetails.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}
bridge.openCreateSection = (updateHash) => void openCreateSection(updateHash);
bridge.createButtonEl = () => createButton.value?.$el;
</script>
<template>
  <details
    id="create-adventure"
    ref="createDetails"
    class="create-pane"
    data-testid="create-adventure-disclosure"
    :open="createOpen"
  >
    <summary
      ref="createSummary"
      class="section-summary"
      data-testid="create-adventure-toggle"
      @click.prevent="onCreateSummaryActivate"
    >
      <h2>Create a new adventure</h2>
    </summary>
    <!-- Adventure Template Selector -->
    <section class="section">
      <div class="template-grid">
        <button
          v-for="tmpl in BUILTIN_TEMPLATES"
          :key="tmpl.id"
          class="template-card"
          :class="{ selected: selectedTemplateId === tmpl.id }"
          :aria-pressed="selectedTemplateId === tmpl.id"
          :data-testid="`template-${tmpl.id}`"
          @click="selectedTemplateId = tmpl.id"
        >
          <span class="template-title">{{ tmpl.title }}</span>
          <span class="template-desc">{{ tmpl.description }}</span>
        </button>
        <button
          class="template-card custom-card"
          :class="{ selected: selectedTemplateId === 'custom' }"
          :aria-pressed="selectedTemplateId === 'custom'"
          data-testid="template-custom"
          @click="selectedTemplateId = 'custom'"
        >
          <span class="template-title">Your own adventure</span>
          <span class="template-desc">Write your own premise.</span>
        </button>
      </div>

      <!-- Adventure brief shared by templates and custom games -->
      <div v-if="selectedTemplateId" class="custom-editor">
        <label for="adventure-name">Adventure name</label>
        <input
          id="adventure-name"
          v-model="adventureDraft.title"
          placeholder="Midnight at the Museum"
          maxlength="100"
        />
        <label for="adventure-brief">Adventure brief</label>
        <p id="adventure-brief-help" class="section-intro">
          Describe your hero, the world and what happens.
        </p>
        <textarea
          id="adventure-brief"
          v-model="adventureDraft.brief"
          aria-label="Adventure brief"
          aria-describedby="adventure-brief-help"
          spellcheck="false"
          placeholder="You are the night guard at a museum where the exhibits come alive. A tiny dinosaur has stolen your keys. Get them back before sunrise.&#10;&#10;Tell us about your hero, the setting, and the trouble they find themselves in."
          rows="8"
          data-testid="custom-adventure-input"
        />
      </div>
    </section>

    <div v-if="!aiConfigured" class="ai-connect" data-testid="create-ai-connect">
      <p>Connect your AI provider to generate a game.</p>
      <UiButton
        variant="primary"
        data-testid="connect-create-ai"
        :disabled="aiSettingsUnavailable"
        @click="openAiSettings($event, 'create')"
      >
        Connect AI
      </UiButton>
    </div>

    <!-- Launch Buttons -->
    <div v-if="aiConfigured" class="boot-row">
      <UiButton
        ref="createButton"
        variant="primary"
        data-testid="boot-game"
        :disabled="!selectedTemplateId || !adventureDraft.brief.trim()"
        @click="onBootSelectedTemplate"
      >
        Create adventure
      </UiButton>
    </div>
  </details>
</template>

<style scoped>
.create-pane {
  font-family: var(--font-sans);
  min-width: 0;
  align-self: start;
  width: 100%;
  box-sizing: border-box;
  padding: 22px;
  background: linear-gradient(135deg, var(--surface-3), var(--surface-1) 68%);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
}
.create-pane > .section:first-of-type {
  margin-top: 0;
}
.section {
  margin: 24px 0;
}

.section-intro {
  margin: 8px 0 16px;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.section h2 {
  font-size: var(--text-lg);
  letter-spacing: 0.02em;
  color: var(--ink);
  margin: 0 0 0.5rem 0;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.template-card {
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  padding: 12px;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius);
  transition: all 0.15s ease;
}

.template-card:hover {
  border-color: var(--hairline-strong);
  background: var(--surface-3);
}

.template-card.selected {
  border-color: var(--action);
  background: var(--action-soft);
}

.custom-card {
  grid-column: 1 / -1;
}

.template-title {
  font-size: var(--text-md);
  font-weight: bold;
  color: var(--ink);
  margin-bottom: 0.25rem;
}

.template-desc {
  font-size: var(--text-xs);
  color: var(--ink-2);
  line-height: 1.5;
}

.custom-editor {
  margin-top: 24px;
}
.custom-editor label {
  display: block;
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-md) / var(--leading) var(--font-sans);
  margin: 16px 0 8px;
}
.custom-editor input,
.custom-editor textarea {
  width: 100%;
  background: var(--surface-0);
  border: 1px solid var(--hairline-strong);
  color: var(--ink);
  font: var(--text-lg) / 1.65 var(--font-sans);
  padding: 14px;
  border-radius: var(--radius);
  box-sizing: border-box;
}
.custom-editor textarea {
  min-height: 230px;
  resize: vertical;
}
.custom-editor textarea::placeholder,
.custom-editor input::placeholder {
  color: var(--ink-3);
  opacity: 1;
}

.boot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
@media (max-width: 600px) {
  .create-pane {
    padding: 18px;
  }
  .template-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
