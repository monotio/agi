<script setup lang="ts">
/**
 * The Help guide: topics for playing and making games, each with an optional
 * "Show me" that opens the real control. The screen passes the actions it can
 * perform; a topic's action is hidden when it is not among them.
 */
import { computed, ref, useTemplateRef } from "vue";
import UiButton from "./ui/UiButton.vue";
import { HELP_SECTIONS, type HelpAction } from "./helpContent.ts";

const props = defineProps<{ available: readonly HelpAction[] }>();
const emit = defineEmits<{ action: [kind: HelpAction] }>();

const dialog = useTemplateRef("dialog");
const sectionId = ref(HELP_SECTIONS[0]!.id);
const section = computed(
  () => HELP_SECTIONS.find((entry) => entry.id === sectionId.value) ?? HELP_SECTIONS[0]!,
);

function open(section?: string): void {
  if (section) sectionId.value = section;
  dialog.value?.showModal();
}

function run(kind: HelpAction): void {
  dialog.value?.close();
  emit("action", kind);
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="help-guide"
    aria-labelledby="help-guide-title"
    data-testid="help-guide"
  >
    <header>
      <h2 id="help-guide-title">Help</h2>
      <UiButton data-testid="help-guide-close" @click="dialog?.close()">Close</UiButton>
    </header>
    <div class="help-body">
      <nav class="help-sections" aria-label="Help sections">
        <button
          v-for="entry in HELP_SECTIONS"
          :key="entry.id"
          type="button"
          :aria-current="entry.id === section.id ? 'true' : undefined"
          :data-testid="`help-section-${entry.id}`"
          @click="sectionId = entry.id"
        >
          {{ entry.title }}
        </button>
      </nav>
      <div class="help-topics" :data-testid="`help-topics-${section.id}`">
        <section v-for="topic in section.topics" :key="topic.id" class="help-topic">
          <h3>{{ topic.title }}</h3>
          <p v-for="(paragraph, index) in topic.body" :key="index">{{ paragraph }}</p>
          <UiButton
            v-if="topic.action && props.available.includes(topic.action.kind)"
            class="help-show-me"
            :data-testid="`help-action-${topic.action.kind}`"
            @click="run(topic.action.kind)"
          >
            {{ topic.action.label }}
          </UiButton>
        </section>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.help-guide {
  background: var(--surface-1);
  color: var(--ink);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-dialog);
  padding: 0.75rem 1rem 1rem;
  width: min(44rem, calc(100vw - 2rem));
  max-height: min(85dvh, 40rem);
  box-sizing: border-box;
  display: none;
  flex-direction: column;
}
.help-guide[open] {
  display: flex;
}
.help-guide::backdrop {
  background: var(--scrim);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.help-body {
  display: grid;
  grid-template-columns: 9.5rem 1fr;
  gap: 1rem;
  min-height: 0;
}
.help-sections {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.help-sections button {
  min-height: var(--control-h);
  padding: 0.5rem 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--ink);
  background: transparent;
  text-align: left;
  font: var(--text-md) / 1.3 var(--font-sans);
  cursor: pointer;
}
.help-sections button:hover {
  background: var(--surface-2);
}
.help-sections button[aria-current="true"] {
  border-color: var(--action);
  color: var(--action);
  background: var(--surface-2);
}
.help-topics {
  overflow-y: auto;
  padding-right: 0.25rem;
}
.help-topic + .help-topic {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--hairline);
}
h3 {
  margin: 0 0 0.35rem;
  font-size: var(--text-lg);
  color: var(--ink);
}
.help-topic p {
  margin: 0 0 0.5rem;
  font: var(--text-md) / 1.55 var(--font-sans);
  color: var(--ink-2);
}
.help-show-me {
  margin-top: 0.25rem;
}
@media (max-width: 600px) {
  .help-body {
    grid-template-columns: 1fr;
  }
  .help-sections {
    flex-direction: row;
    overflow-x: auto;
  }
  .help-sections button {
    flex: 0 0 auto;
  }
}
</style>
