<script setup lang="ts">
import UiIcon from "../ui/UiIcon.vue";
/**
 * The Help guide: topics for playing and making games, each with an optional
 * "Show me" that opens the real control. The screen passes the actions it can
 * perform; a topic's action is hidden when it is not among them. A game with
 * Studio lessons (lessons/registry.ts) adds a section of them: each opens a
 * Studio on the lesson's resource, and shows whether its challenge is done.
 * `open` can land on one topic: the guide scrolls to its heading and focuses
 * it, so an explainer's "Learn more" (UiExplain.vue) arrives where it points.
 */
import { computed, nextTick, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import KeyboardShortcuts from "./commands/KeyboardShortcuts.vue";
import { useOptionalCommands } from "./commands/commandContext.ts";
import UiChip from "../ui/UiChip.vue";
import UiDialog from "../ui/UiDialog.vue";
import { HELP_SECTIONS, type HelpActionKind, type HelpRequest } from "./helpContent.ts";
import { useLessonBadges } from "../lessons/lessonStorage.ts";
import type { LessonSet, StudioLesson } from "../lessons/types.ts";

const props = defineProps<{
  available: readonly HelpActionKind[];
  /** The running game's Studio lessons, if it has any. */
  lessons?: LessonSet | undefined;
}>();
const emit = defineEmits<{ action: [request: HelpRequest]; lesson: [lesson: StudioLesson] }>();

const commands = useOptionalCommands();
const shortcutsShown = computed(() => sectionId.value === "shortcuts" && commands);
const LESSONS_SECTION = "lessons";
const shown = ref(false);
const sectionId = ref(HELP_SECTIONS[0]!.id);
const lessonSection = computed(() => sectionId.value === LESSONS_SECTION && props.lessons);
const section = computed(
  () => HELP_SECTIONS.find((entry) => entry.id === sectionId.value) ?? HELP_SECTIONS[0]!,
);
const completed = useLessonBadges().completed;

function open(section?: string, topic?: string): void {
  if (section) sectionId.value = section;
  shown.value = true;
  // Two ticks: the dialog shows itself (and focuses its first control) after the first.
  if (topic)
    void nextTick()
      .then(() => nextTick())
      .then(() => {
        const heading = document.getElementById(`help-topic-${topic}`);
        heading?.scrollIntoView({ block: "start" });
        heading?.focus({ preventScroll: true });
      });
}

function run(request: HelpRequest): void {
  shown.value = false;
  emit("action", request);
}

const studioKind = (lesson: StudioLesson): HelpActionKind =>
  lesson.open.studio === "room" ? "openRoomStudio" : "openSpriteStudio";

function runLesson(lesson: StudioLesson): void {
  shown.value = false;
  emit("lesson", lesson);
}

defineExpose({ open });
</script>

<template>
  <UiDialog
    v-model:open="shown"
    title="Help"
    size="lg"
    class="help-guide"
    close-testid="help-guide-close"
    data-testid="help-guide"
  >
    <div class="help-body">
      <nav class="help-sections" aria-label="Help sections">
        <button
          v-for="entry in HELP_SECTIONS"
          :key="entry.id"
          type="button"
          :aria-current="
            !lessonSection && !shortcutsShown && entry.id === section.id ? 'true' : undefined
          "
          :data-testid="`help-section-${entry.id}`"
          @click="sectionId = entry.id"
        >
          {{ entry.title }}
        </button>
        <button
          v-if="commands?.commands.value.length"
          type="button"
          :aria-current="shortcutsShown ? 'true' : undefined"
          data-testid="help-section-shortcuts"
          @click="sectionId = 'shortcuts'"
        >
          Keyboard shortcuts
        </button>
        <button
          v-if="lessons"
          type="button"
          :aria-current="lessonSection ? 'true' : undefined"
          :data-testid="`help-section-${LESSONS_SECTION}`"
          @click="sectionId = LESSONS_SECTION"
        >
          {{ lessons.title }}
        </button>
      </nav>
      <KeyboardShortcuts v-if="shortcutsShown" :registry="shortcutsShown" />
      <div
        v-else-if="lessonSection"
        class="help-topics"
        :data-testid="`help-topics-${LESSONS_SECTION}`"
      >
        <section
          v-for="lesson in lessonSection.lessons"
          :key="lesson.id"
          class="help-topic"
          :data-testid="`help-lesson-${lesson.id}`"
        >
          <h3 class="help-lesson__title">
            {{ lesson.title }}
            <template v-if="lesson.challenge">
              <UiChip v-if="completed.has(lesson.id)" tone="ok" data-testid="help-lesson-badge">
                <UiIcon name="check" :size="16" /> Done
              </UiChip>
              <UiChip v-else data-testid="help-lesson-badge">Not yet done</UiChip>
            </template>
          </h3>
          <p>{{ lesson.teaser }}</p>
          <p v-if="lesson.challenge" class="help-lesson__challenge">
            Challenge: {{ lesson.challenge.prompt }}
          </p>
          <UiButton
            v-if="props.available.includes(studioKind(lesson))"
            class="help-show-me"
            icon="pencil"
            data-testid="help-lesson-open"
            @click="runLesson(lesson)"
          >
            Open in Studio
          </UiButton>
        </section>
      </div>
      <div v-else class="help-topics" :data-testid="`help-topics-${section.id}`">
        <section
          v-for="topic in section.topics"
          :key="topic.id"
          class="help-topic"
          :data-topic="topic.id"
        >
          <h3 :id="`help-topic-${topic.id}`" tabindex="-1">{{ topic.title }}</h3>
          <p v-for="(paragraph, index) in topic.body" :key="index">{{ paragraph }}</p>
          <UiButton
            v-if="topic.action && props.available.includes(topic.action.kind)"
            class="help-show-me"
            :data-testid="`help-action-${topic.action.kind}`"
            @click="run(topic.action)"
          >
            {{ topic.action.label }}
          </UiButton>
        </section>
      </div>
    </div>
  </UiDialog>
</template>

<style scoped>
.help-guide.ui-dialog {
  width: min(46rem, calc(100vw - 2rem));
}
.help-body {
  display: grid;
  grid-template-columns: 9.5rem 1fr;
  gap: var(--space-5);
  min-height: 0;
}
.help-sections {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  align-self: start;
  gap: var(--space-1);
}
.help-sections button {
  min-height: var(--control-h-sm);
  padding: var(--space-2) var(--space-4);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  text-align: left;
  font: var(--weight-semibold) var(--text-sm) / 1.3 var(--font-sans);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.help-sections button:hover {
  color: var(--ink);
  background: var(--surface-2);
}
.help-sections button[aria-current="true"] {
  color: var(--ink);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.help-topics {
  min-width: 0;
}
.help-topic + .help-topic {
  margin-top: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--hairline);
}
h3 {
  scroll-margin-top: var(--space-5);
  margin: 0 0 var(--space-2);
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
  color: var(--ink);
}
.help-topic p {
  margin: 0 0 var(--space-3);
  font: var(--text-md) / 1.55 var(--font-sans);
  color: var(--ink-2);
}
h3:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.help-show-me {
  margin-top: var(--space-1);
}
.help-lesson__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.help-topic .help-lesson__challenge {
  color: var(--ink);
}
@media (max-width: 600px) {
  .help-body {
    grid-template-columns: 1fr;
  }
  /* Every section stays in view: the tabs wrap rather than scroll a
     half-cut "About" off the edge. */
  .help-sections {
    position: static;
    flex-flow: row wrap;
  }
  .help-sections button {
    flex: 0 0 auto;
  }
}
</style>
