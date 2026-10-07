<script setup lang="ts">
/**
 * A starting point on the Home shelf. Its Create button opens the new game form.
 */
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import GameCard from "./GameCard.vue";

const { blank = false, detail = undefined } = defineProps<{
  title: string;
  detail?: string;
  testId: string;
  blank?: boolean;
}>();
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <GameCard :title :monogram="title" :meta="detail" class="template-shelf-card">
    <template #media>
      <span class="template-art" :class="{ blank }" aria-hidden="true">
        <UiIcon v-if="blank" name="plus" :size="28" />
        <template v-else>{{ title }}</template>
      </span>
    </template>
    <template #actions>
      <UiButton
        class="game-card__actions-main"
        :data-testid="testId"
        :aria-label="`Create: ${title}`"
        @click="emit('select')"
      >
        Create
      </UiButton>
    </template>
  </GameCard>
</template>

<style scoped>
:deep(.game-card__meta) {
  white-space: normal;
}
.template-art {
  display: grid;
  height: 100%;
  box-sizing: border-box;
  place-items: center;
  padding: var(--space-4);
  color: var(--ink-3);
  background: radial-gradient(circle at 30% 20%, var(--surface-3), var(--surface-sunken));
  font: var(--weight-bold) var(--text-xs) / 1.4 var(--font-mono);
  letter-spacing: 0.1em;
  text-align: center;
  text-transform: uppercase;
}
.template-art.blank {
  color: var(--action);
  background: var(--surface-2);
  border-bottom: 1px dashed var(--hairline-strong);
}
</style>
