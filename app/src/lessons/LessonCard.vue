<script setup lang="ts">
/**
 * The "Try this" card a Studio shows when a Help guide lesson opened it:
 * the lesson's steps and challenge, docked in a corner of the canvas area,
 * with the last Keep's verdict. Hiding it folds it to a small tab, and the
 * fold is remembered per lesson in this browser (lessonStorage.ts).
 */
import { computed, ref, watch } from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { LessonOutcome, LessonSession } from "./lessonCheck.ts";
import { readFoldedCards, setCardFolded, useLessonBadges } from "./lessonStorage.ts";

const { session, outcome } = defineProps<{
  session: LessonSession;
  outcome: LessonOutcome | null;
}>();

const lesson = computed(() => session.lesson);
const completed = useLessonBadges().completed;
const done = computed(() => completed.value.has(lesson.value.id));
const folded = ref(false);
watch(
  () => lesson.value.id,
  (id) => (folded.value = readFoldedCards().has(id)),
  { immediate: true },
);

function fold(next: boolean): void {
  folded.value = next;
  setCardFolded(lesson.value.id, next);
}
</script>

<template>
  <button
    v-if="folded"
    type="button"
    class="lesson-tab"
    data-testid="lesson-card-show"
    :aria-label="`Show Try this: ${lesson.title}`"
    @click="fold(false)"
  >
    Try this<span v-if="done" class="lesson-tab__done"> ✓</span>
  </button>
  <aside
    v-else
    class="lesson-card"
    data-testid="lesson-card"
    :aria-label="`Try this: ${lesson.title}`"
  >
    <header class="lesson-card__head">
      <span class="lesson-card__eyebrow">Try this</span>
      <UiIconButton
        icon="x"
        size="sm"
        label="Hide Try this"
        data-testid="lesson-card-hide"
        @click="fold(true)"
      />
    </header>
    <h3 class="lesson-card__title">{{ lesson.title }}</h3>
    <ol class="lesson-card__steps">
      <li v-for="(step, index) in lesson.steps" :key="index">{{ step }}</li>
    </ol>
    <p v-if="lesson.challenge" class="lesson-card__challenge">
      <b>Challenge</b> {{ lesson.challenge.prompt }}
    </p>
    <p
      v-if="outcome"
      class="lesson-card__verdict"
      :class="outcome.ok ? 'is-ok' : 'is-warn'"
      data-testid="lesson-card-verdict"
    >
      {{ outcome.message }}
    </p>
    <p
      v-else-if="lesson.challenge && done"
      class="lesson-card__verdict is-ok"
      data-testid="lesson-card-verdict"
    >
      ✓ Done
    </p>
  </aside>
</template>

<style scoped>
/* Bottom right of the canvas area, stacked above the zoom control. */
.lesson-card,
.lesson-tab {
  position: absolute;
  right: var(--space-4);
  bottom: calc(2 * var(--space-4) + var(--control-h));
  z-index: 1;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
}
.lesson-card {
  width: min(264px, calc(100% - 2 * var(--space-4)));
  max-height: calc(100% - 3 * var(--space-4) - 2 * var(--control-h));
  overflow-y: auto;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3) var(--space-3) var(--space-4);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.lesson-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.lesson-card__eyebrow {
  color: var(--action);
  font-weight: var(--weight-semibold);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.lesson-card__title {
  margin: 0 0 var(--space-2);
  color: var(--ink);
  font-size: var(--text-sm);
}
.lesson-card__steps {
  margin: 0;
  padding-left: var(--space-5);
}
.lesson-card__steps li + li {
  margin-top: var(--space-1);
}
.lesson-card__challenge {
  margin: var(--space-3) 0 0;
  color: var(--ink);
}
.lesson-card__challenge b {
  color: var(--action);
  font-weight: var(--weight-semibold);
}
.lesson-card__verdict {
  margin: var(--space-3) 0 0;
  padding-top: var(--space-2);
  border-top: 1px solid var(--hairline);
}
.lesson-card__verdict.is-ok {
  color: var(--ok);
}
.lesson-card__verdict.is-warn {
  color: var(--warn);
}
.lesson-tab {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-4);
  color: var(--action);
  font: var(--weight-medium) var(--text-xs) var(--font-sans);
  cursor: pointer;
}
.lesson-tab:hover {
  background: var(--surface-2);
}
.lesson-tab:focus-visible {
  outline: 2px solid var(--focus);
}
.lesson-tab__done {
  color: var(--ok);
}
</style>
