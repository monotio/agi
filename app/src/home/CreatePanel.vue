<script setup lang="ts">
/** The new game page shares one name and one starting-point choice. */
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  useTemplateRef,
  watch,
} from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { BUILTIN_TEMPLATES } from "../library/gameTemplates.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { prefetchAuthoringStack } from "../agent/authoringLoader.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useShell } from "../shell/useShell.ts";
import type { StarterKind } from "../../../src/authoring/starterProject.ts";
import { openEmptyProject } from "./emptyProjectRoute.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";

const open = defineModel<boolean>("open", { required: true });
const LocalProjectForm = defineAsyncComponent(() => import("./LocalProjectForm.vue"));
const { aiConfigured, aiSettingsUnavailable, openAiSettings } = useAiSettings();
const {
  selectedTemplateId,
  adventureDraft,
  adventureDrafts,
  onBootSelectedTemplate,
  refreshLibrary,
  onBootSavedGame,
} = useGameLibrary();
const shell = useShell();
const engine = useEngineApi();
const bridge = useShellBridge();
// Warm the optional assistant when a player selects an AI brief.
watch(
  [open, selectedTemplateId],
  ([shown, template]) => shown && template && prefetchAuthoringStack(),
);

// The boot resolves while the game is still loading; the shell holds the
// Create switch until this project is the running one.
async function onLocalCreated(projectId: ProjectId, kind: StarterKind): Promise<void> {
  engine.setProjectMode("create");
  refreshLibrary(projectId);
  if (kind === "blank") {
    await openEmptyProject(projectId);
    return;
  }
  await onBootSavedGame();
  shell.expectCreate(projectId);
}

const panel = useTemplateRef("panel");
const form = useTemplateRef("form");
watch(
  form,
  (value) => {
    if (open.value) value?.focus();
  },
  { flush: "post" },
);

const HASH = "#create-adventure";
let returnFocus: HTMLElement | null = null;

async function openCreateSection(updateHash = true): Promise<void> {
  if (!open.value)
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open.value = true;
  if (updateHash && location.hash !== HASH) history.pushState(null, "", HASH);
  await nextTick();
  if (selectedTemplateId.value) form.value?.select("ai");
  if (form.value) form.value.focus();
  else panel.value?.focus({ preventScroll: true });
  panel.value?.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

async function closeCreateSection(): Promise<void> {
  open.value = false;
  if (location.hash === HASH)
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  await nextTick();
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
bridge.createButtonEl = () =>
  panel.value?.querySelector<HTMLButtonElement>('[data-testid="boot-game"]');

function chooseAi(): void {
  if (!selectedTemplateId.value) selectedTemplateId.value = BUILTIN_TEMPLATES[0]!.id;
}
watch(selectedTemplateId, (id) => {
  if (id) form.value?.select("ai");
});
// Keep the complete source in the existing per-adventure draft store.
watch(
  selectedTemplateId,
  (id) => {
    const draft = adventureDrafts.value[id];
    if (!draft || !draft.frontmatter || id === "custom") return;
    const original = BUILTIN_TEMPLATES.find((template) => template.id === id);
    const body = original?.rawMarkdown.slice(draft.frontmatter.length).trimStart();
    draft.brief =
      original && draft.brief === body
        ? original.rawMarkdown
        : `${draft.frontmatter}\n${draft.brief}`;
    draft.frontmatter = "";
  },
  { immediate: true },
);
const outlineFile = computed(
  () => `${selectedTemplateId.value === "custom" ? "your-premise" : selectedTemplateId.value}.md`,
);

async function onAiCreated(title: string): Promise<void> {
  adventureDraft.value.title = title;
  const { completeAdventureOutline } = await import("../library/gameTemplates.ts");
  adventureDraft.value.brief = completeAdventureOutline(adventureDraft.value.brief, title).trim();
  adventureDraft.value.frontmatter = "";
  await onBootSelectedTemplate();
  const { currentGame } = engine;
  const projectId = currentGame()?.projectId;
  if (projectId) shell.expectCreate(projectId);
}
</script>
<template>
  <dialog
    id="create-adventure"
    ref="panel"
    class="create-pane"
    data-testid="create-adventure-disclosure"
    tabindex="-1"
    :open
    aria-labelledby="create-title"
    @keydown.esc.stop="closeCreateSection"
  >
    <header class="create-head">
      <div>
        <h1 id="create-title">Make a new game</h1>
        <p class="lead">Pick a place to start. You can change everything later.</p>
      </div>
      <UiIconButton
        icon="x"
        label="Close"
        data-testid="create-adventure-close"
        @click="closeCreateSection"
      />
    </header>
    <LocalProjectForm
      v-if="open"
      ref="form"
      :initial-choice="selectedTemplateId ? 'ai' : 'starter'"
      :ai-ready="aiConfigured"
      :ai-unavailable="aiSettingsUnavailable"
      :ai-valid="Boolean(adventureDraft.brief.trim())"
      @created="onLocalCreated"
      @ai="onAiCreated"
      @choice="$event === 'ai' && chooseAi()"
      @connect="openAiSettings($event, 'create')"
    >
      <template #ai>
        <div class="ai-pick">
          <div class="ai-list" role="listbox" aria-label="Adventure">
            <button
              v-for="template in BUILTIN_TEMPLATES"
              :key="template.id"
              type="button"
              role="option"
              :aria-selected="selectedTemplateId === template.id"
              :data-testid="`template-${template.id}`"
              @click="selectedTemplateId = template.id"
            >
              <strong>{{ template.title }}</strong
              ><span>{{ template.description }}</span>
            </button>
            <button
              type="button"
              role="option"
              :aria-selected="selectedTemplateId === 'custom'"
              data-testid="template-custom"
              @click="selectedTemplateId = 'custom'"
            >
              <strong>Your own premise</strong><span>Start from an empty outline.</span>
            </button>
          </div>
          <div class="ai-brief">
            <div class="ai-brief-h">
              <label for="adventure-brief">Outline</label><span class="id">{{ outlineFile }}</span>
            </div>
            <textarea
              id="adventure-brief"
              v-model="adventureDraft.brief"
              aria-label="Adventure outline"
              spellcheck="false"
              data-testid="custom-adventure-input"
            />
            <p class="note">
              AI starts from Boilerplate and builds the game while you watch. You can edit every
              part afterwards.
            </p>
          </div>
        </div>
      </template>
    </LocalProjectForm>
  </dialog>
</template>

<style scoped>
.create-pane {
  position: static;
  width: min(960px, 100%);
  box-sizing: border-box;
  margin: 0 auto;
  padding: var(--space-9) 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  font-family: var(--font-sans);
}
.create-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-7);
}
.create-head h1 {
  margin: 0;
  font-size: var(--text-2xl);
  line-height: var(--leading-tight);
  text-wrap: balance;
}
.lead {
  margin: var(--space-2) 0 0;
  color: var(--ink-2);
  font-size: var(--text-lg);
}
.ai-pick {
  display: grid;
  grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
  gap: var(--space-5);
}
.ai-list {
  display: grid;
  gap: var(--space-2);
  align-content: start;
}
.ai-list button {
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: var(--space-4);
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--surface-1);
  display: grid;
  gap: var(--space-0);
  cursor: pointer;
}
.ai-list button span {
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.ai-list button[aria-selected="true"] {
  border-color: var(--action);
  box-shadow: 0 0 0 1px var(--action);
}
.ai-brief {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}
.ai-brief-h {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ai-brief-h label {
  color: var(--ink-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.id {
  font: var(--text-2xs) var(--font-mono);
  color: var(--ink-3);
}
.ai-brief textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 220px;
  resize: vertical;
  padding: var(--space-4);
  border-radius: var(--radius);
  border: 1px solid var(--hairline-strong);
  background: var(--surface-0);
  color: var(--ink);
  font: var(--text-sm) / 1.6 var(--font-mono);
}
.note {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
@media (max-width: 760px) {
  .ai-pick {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
