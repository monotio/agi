<script setup lang="ts">
/**
 * Create an adventure: a focused panel on the Home screen with the template
 * picker, the shared adventure brief editor, the AI-connect prompt and the
 * launch button. It opens from the hero, a template card on the shelf, the
 * Help guide or the `#create-adventure` hash, and registers
 * `openCreateSection` and the create button's element on the shell bridge so
 * the header and the AI settings flow can reach them. It is a non-modal
 * dialog: the header (AI settings, Help) stays usable while it is open.
 */
import { nextTick, onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import UiButton from "./ui/UiButton.vue";
import UiIconButton from "./ui/UiIconButton.vue";
import { BUILTIN_TEMPLATES } from "./gameTemplates.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";

const open = defineModel<boolean>("open", { required: true });
const { aiConfigured, aiSettingsUnavailable, openAiSettings } = useAiSettings();
const { selectedTemplateId, adventureDraft, onBootSelectedTemplate } = useGameLibrary();
const bridge = useShellBridge();

const panel = useTemplateRef("panel");
const heading = useTemplateRef("heading");
const createButton = useTemplateRef("createButton");
const HASH = "#create-adventure";
let returnFocus: HTMLElement | null = null;

async function openCreateSection(updateHash = true): Promise<void> {
  if (!open.value)
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open.value = true;
  if (updateHash && location.hash !== HASH) history.pushState(null, "", HASH);
  await nextTick();
  heading.value?.focus({ preventScroll: true });
  panel.value?.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

function closeCreateSection(): void {
  open.value = false;
  if (location.hash === HASH)
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
}

/** Back out of the hash (browser Back) closes the panel too. */
function onHashChange(): void {
  if (open.value && location.hash !== HASH) open.value = false;
}
onMounted(() => window.addEventListener("hashchange", onHashChange));
onBeforeUnmount(() => window.removeEventListener("hashchange", onHashChange));

bridge.openCreateSection = (updateHash) => void openCreateSection(updateHash);
bridge.createButtonEl = () => createButton.value?.$el;
</script>
<template>
  <dialog
    id="create-adventure"
    ref="panel"
    class="create-pane"
    data-testid="create-adventure-disclosure"
    :open
    aria-labelledby="create-title"
    @keydown.esc.stop="closeCreateSection"
  >
    <header class="create-head">
      <div>
        <h2 id="create-title" ref="heading" tabindex="-1">Create an adventure</h2>
        <p class="create-intro">
          Pick a template or write your own premise. The AI builds it as a real AGI game you can
          play, remix and export.
        </p>
      </div>
      <UiIconButton
        icon="x"
        label="Close"
        data-testid="create-adventure-close"
        @click="closeCreateSection"
      />
    </header>
    <div class="create-body">
      <div class="template-grid" role="group" aria-label="Starting point">
        <button
          v-for="tmpl in BUILTIN_TEMPLATES"
          :key="tmpl.id"
          type="button"
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
          type="button"
          class="template-card custom-card"
          :class="{ selected: selectedTemplateId === 'custom' }"
          :aria-pressed="selectedTemplateId === 'custom'"
          data-testid="template-custom"
          @click="selectedTemplateId = 'custom'"
        >
          <span class="template-title">Your own premise</span>
          <span class="template-desc">Start from a blank brief.</span>
        </button>
      </div>

      <div class="create-editor">
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
          <p id="adventure-brief-help" class="create-help">
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
        <p v-else class="create-empty">Choose a starting point to write the brief.</p>

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

        <div v-if="aiConfigured" class="boot-row">
          <UiButton
            ref="createButton"
            variant="primary"
            icon="sparkles"
            data-testid="boot-game"
            :disabled="!selectedTemplateId || !adventureDraft.brief.trim()"
            @click="onBootSelectedTemplate"
          >
            Create adventure
          </UiButton>
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
/* A non-modal dialog laid out in the page flow, not floated by the UA sheet. */
.create-pane {
  position: static;
  width: 100%;
  max-width: none;
  box-sizing: border-box;
  margin: 0;
  padding: var(--space-7);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  font-family: var(--font-sans);
  scroll-margin-top: var(--space-6);
}
.create-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
.create-head h2 {
  margin: 0 0 var(--space-1);
  font: var(--weight-semibold) var(--text-xl) / var(--leading-tight) var(--font-sans);
}
.create-intro {
  max-width: 60ch;
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.create-body {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: var(--space-7);
  align-items: start;
}
.template-grid {
  display: grid;
  gap: var(--space-3);
}
.template-card {
  display: flex;
  flex-direction: column;
  padding: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: inherit;
  background: var(--surface-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}
.template-card:hover {
  border-color: var(--hairline-strong);
  background: var(--surface-3);
}
.template-card.selected {
  border-color: var(--action);
  background: var(--action-soft);
}
.template-title {
  margin-bottom: var(--space-1);
  color: var(--ink);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.template-desc {
  color: var(--ink-2);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.create-empty {
  margin: 0 0 var(--space-6);
  padding: var(--space-8) var(--space-6);
  border: 1px dashed var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink-3);
  text-align: center;
}
.custom-editor label {
  display: block;
  margin: 0 0 var(--space-3);
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-md) / var(--leading) var(--font-sans);
}
.custom-editor input + label {
  margin-top: var(--space-5);
}
.create-help {
  margin: calc(-1 * var(--space-2)) 0 var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.custom-editor input,
.custom-editor textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-lg) / 1.65 var(--font-sans);
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
.ai-connect {
  margin-top: var(--space-6);
  color: var(--ink-2);
  font-size: var(--text-md);
}
.ai-connect p {
  margin: 0 0 var(--space-4);
}
.boot-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-6);
}
@media (max-width: 760px) {
  .create-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .template-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 520px) {
  .create-pane {
    padding: var(--space-5);
  }
  .template-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
