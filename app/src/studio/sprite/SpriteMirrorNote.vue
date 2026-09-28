<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiExplain from "../../ui/UiExplain.vue";
import type { SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import { explain } from "../studioTerms.ts";
import { aliasGroup } from "./spriteView.ts";

/**
 * Mirror loops in the cel section, as one chip: "⇋ Loop 1 mirrors this" (or
 * "⇋ Mirrors loop 0") with its ⓘ, and Edit both, which edits the pair
 * together, a mirrored loop showing the edit flipped. Copy-on-write is the
 * default: an edit of one loop of the pair makes it its own copy and leaves
 * the other as it is. With Edit both on, Edit one turns it off again; after
 * a split the chip says which loop became its own copy.
 */
const { document, loop, propagate, isolated } = defineProps<{
  document: SpriteDocument;
  loop: number;
  /** Edits change the whole linked group. */
  propagate: boolean;
  /** Loops the last edit split off. */
  isolated: readonly number[];
}>();
const emit = defineEmits<{
  /** Edit `loop` with its linked loops together (true) or on its own (false). */
  propagate: [loop: number, on: boolean];
}>();

const names = (loops: readonly number[]): string =>
  loops.length === 1
    ? `loop ${loops[0]}`
    : `loops ${loops.slice(0, -1).join(", ")} and ${loops.at(-1)}`;
const capital = (text: string): string => `${text[0]!.toUpperCase()}${text.slice(1)}`;

const note = computed(() => {
  const group = aliasGroup(document, loop);
  const others = group.filter((member) => member !== loop);
  const owner = group[0]!;
  if (others.length > 0 && propagate)
    return {
      tone: "action",
      text: `Edits change ${names(others)} too`,
      action: { label: "Edit one", on: false },
    };
  if (others.length > 0)
    return {
      tone: "neutral",
      text:
        loop === owner
          ? `${capital(names(others))} ${others.length === 1 ? "mirrors" : "mirror"} this`
          : `Mirrors loop ${owner}`,
      action: { label: "Edit both", on: true },
    };
  if (isolated.includes(loop))
    return { tone: "ok", text: `Loop ${loop} is its own copy now`, action: null };
  return null;
});
</script>

<template>
  <div v-if="note" class="mirror-note" data-testid="sprite-mirror-note">
    <span class="mirror-note__chip" :class="`is-${note.tone}`" role="status">
      <span aria-hidden="true">⇋</span>
      <span data-testid="sprite-mirror-text">{{ note.text }}</span>
      <UiExplain v-if="note.action" v-bind="explain('mirror')" />
    </span>
    <UiButton
      v-if="note.action"
      size="sm"
      :variant="note.action.on ? 'ghost' : 'secondary'"
      data-testid="sprite-propagate"
      @click="emit('propagate', loop, note.action.on)"
    >
      {{ note.action.label }}
    </UiButton>
  </div>
</template>

<style scoped>
.mirror-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.mirror-note__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
  box-sizing: border-box;
  padding: 0 var(--space-1) 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-2);
  background: var(--surface-2);
  font-size: var(--text-xs);
}
.mirror-note__chip.is-action {
  border-color: var(--action-line);
  color: var(--action);
  background: var(--action-soft);
}
.mirror-note__chip.is-ok {
  padding-right: var(--space-3);
  border-color: var(--ok-line);
  color: var(--ok);
  background: var(--ok-soft);
}
</style>
