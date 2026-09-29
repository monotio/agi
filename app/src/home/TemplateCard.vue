<script setup lang="ts">
/**
 * A creation starting point on the Home shelf, a template or the blank "your
 * own premise", in the shelf's card anatomy. Its screen and its Create button
 * both open the create panel on that starting point.
 */
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import GameCard from "./GameCard.vue";

const { blank = false } = defineProps<{
  title: string;
  detail: string;
  testId: string;
  blank?: boolean;
}>();
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <GameCard
    :title
    :monogram="title"
    :meta="detail"
    play-label="Create"
    class="template-shelf-card"
    @play="emit('select')"
  >
    <template #media>
      <span class="template-art" :class="{ blank }" aria-hidden="true">
        <UiIcon v-if="blank" name="plus" :size="28" />
        <template v-else>{{ title }}</template>
      </span>
    </template>
    <template #actions>
      <UiButton
        class="game-card__actions-main"
        icon="sparkles"
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
