<script setup lang="ts">
import { computed, watch } from "vue";
import { parseSentence } from "../../../../src/runtime/parser.ts";
import AgiMessagePreview from "./AgiMessagePreview.vue";
import UiButton from "../../ui/UiButton.vue";
const {
  words,
  reply = true,
  disabled = false,
} = defineProps<{
  words: readonly (readonly [string, number])[];
  reply?: boolean;
  disabled?: boolean;
}>();
const command = defineModel<string>("command", { required: true });
const response = defineModel<string>("response", { default: "" });
const also = defineModel<readonly string[]>("also", { default: () => [] });
watch(command, () => {
  also.value = [];
});
const check = computed(() => {
  const dictionary = new Map(words);
  const primary = parseSentence(command.value, dictionary);
  if (primary.unknownPosition || !primary.words.length)
    return { answers: [], misses: [], offer: "" };
  const kept = primary.tokens
    .filter((token) => token.status === "known")
    .map((token) => token.text);
  const tail = kept.slice(1).join(" ");
  const examples = [
    ...new Set([
      command.value,
      kept.join(" "),
      kept.at(-1)!,
      ...(tail ? [`examine ${tail}`, `inspect ${tail}`] : []),
      ...also.value,
    ]),
  ];
  const patterns = [primary, ...also.value.map((sentence) => parseSentence(sentence, dictionary))];
  const answers: string[] = [];
  const misses: string[] = [];
  for (const example of examples) {
    const parsed = parseSentence(example, dictionary);
    const matches =
      !parsed.unknownPosition &&
      patterns.some(
        (pattern) =>
          !pattern.unknownPosition &&
          parsed.words.length === pattern.words.length &&
          parsed.words.every((id, index) => id === pattern.words[index]),
      );
    (matches ? answers : misses).push(example);
  }
  return {
    answers,
    misses,
    offer: misses.find((sentence) => /^(examine|inspect) /.test(sentence)) ?? "",
  };
});
</script>
<template>
  <label
    >When the player types…<input v-model="command" placeholder="look at sun" required :disabled
  /></label>
  <p
    v-if="check.answers.length"
    class="parser-check"
    data-testid="guided-parser-check"
    aria-live="polite"
  >
    Answers: {{ check.answers.join(", ")
    }}<template v-if="check.misses.length"> · Not: {{ check.misses.join(", ") }}</template>
  </p>
  <UiButton
    v-if="reply && check.offer"
    size="sm"
    variant="ghost"
    :disabled
    :title="disabled ? 'Finish the current change, then add an answer' : undefined"
    @click="also = [...also, check.offer]"
    >Also answer {{ check.offer }}</UiButton
  >
  <template v-if="reply">
    <label
      >The game says…<textarea v-model="response" required maxlength="512" rows="2" :disabled />
    </label>
    <AgiMessagePreview v-if="response" :text="response" />
  </template>
</template>
<style scoped>
label {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0;
  font-size: var(--text-sm);
  color: var(--ink-2);
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2);
  background: var(--surface-0);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  font: inherit;
}
textarea {
  resize: vertical;
}
.parser-check {
  margin: var(--space-2) 0;
  font-size: var(--text-xs);
  line-height: var(--leading);
  color: var(--ink-2);
}
</style>
