<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import UiDialog from "../ui/UiDialog.vue";

/**
 * The room's logic as text, read only: the annotated source when it is
 * trusted, else a disassembly. Native exits change here in words — the
 * assistant (Create’s agent) can edit the logic; Room Studio's door tools
 * only edit the rules they wrote. The line a door starts on is marked and
 * scrolled into view.
 */
const {
  room,
  text,
  line = null,
} = defineProps<{
  room: number;
  text: string;
  line?: number | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const lines = computed(() => text.split("\n"));
const body = useTemplateRef("body");
watch(open, async (value) => {
  if (!value || line === null) return;
  await nextTick();
  body.value?.querySelector(".is-mark")?.scrollIntoView({ block: "center" });
});
</script>

<template>
  <UiDialog
    v-model:open="open"
    size="lg"
    :title="`Room ${room} logic`"
    description="Ask the agent in Create to change this exit."
  >
    <pre ref="body" class="logic-text" data-testid="logic-text"><code><span
      v-for="(content, index) in lines"
      :key="index"
      class="logic-text__line"
      :class="{ 'is-mark': line === index + 1 }"
      ><i aria-hidden="true">{{ index + 1 }}</i>{{ content }}
</span></code></pre>
  </UiDialog>
</template>

<style scoped>
.logic-text {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  padding: var(--space-3) 0;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-sunken);
  color: var(--ink);
  font: var(--text-xs) / var(--leading) var(--font-mono);
}
.logic-text__line {
  display: block;
  padding: 0 var(--space-4) 0 0;
}
.logic-text__line i {
  display: inline-block;
  width: var(--space-8);
  margin-right: var(--space-3);
  color: var(--ink-3);
  font-style: normal;
  text-align: right;
  user-select: none;
}
.logic-text__line.is-mark {
  background: var(--action-soft);
}
</style>
