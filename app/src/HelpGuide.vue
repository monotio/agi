<script setup lang="ts">
/**
 * The Help guide: topics for playing and making games, each with an optional
 * "Show me" that opens the real control. The screen passes the actions it can
 * perform; a topic's action is hidden when it is not among them.
 */
import { computed, ref, useTemplateRef } from "vue";
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
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="help-guide-close"
        @click="dialog?.close()"
      >
        Close
      </button>
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
          <button
            v-if="topic.action && props.available.includes(topic.action.kind)"
            type="button"
            class="ui-button ui-button--secondary help-show-me"
            :data-testid="`help-action-${topic.action.kind}`"
            @click="run(topic.action.kind)"
          >
            {{ topic.action.label }}
          </button>
        </section>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.help-guide {
  background: #0b171d;
  color: #e3ecee;
  border: 1px solid #6bafb5;
  border-radius: 10px;
  box-shadow: 0 12px 36px #000a;
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
  background: rgba(0, 0, 0, 0.55);
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
  font-size: 16px;
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
  min-height: 40px;
  padding: 0.5rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 5px;
  color: #cfe3e5;
  background: transparent;
  text-align: left;
  font:
    14px/1.3 system-ui,
    sans-serif;
  cursor: pointer;
}
.help-sections button:hover {
  background: var(--ui-action-surface);
}
.help-sections button[aria-current="true"] {
  border-color: var(--ui-action);
  color: var(--ui-action);
  background: var(--ui-action-surface);
}
.help-topics {
  overflow-y: auto;
  padding-right: 0.25rem;
}
.help-topic + .help-topic {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #1d3137;
}
h3 {
  margin: 0 0 0.35rem;
  font-size: 15px;
  color: #f2fbfb;
}
.help-topic p {
  margin: 0 0 0.5rem;
  font:
    14px/1.55 system-ui,
    sans-serif;
  color: #b9cdd1;
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
