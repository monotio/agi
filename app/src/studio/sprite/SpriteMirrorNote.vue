<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiIcon from "../../ui/UiIcon.vue";
import type { SpriteDocument } from "../../../../src/studio/sprite/spriteDocument.ts";
import { aliasGroup } from "./spriteView.ts";

/**
 * Copy-on-write, stated plainly. Editing a loop that shares its data block
 * (a mirror) makes it a separate copy and leaves the others as they are;
 * editing the shared block itself — "Edit loop N instead", every linked loop
 * changing together — is an explicit choice. After a split it says which
 * loop became its own copy, and a view used by several rooms says so.
 */
const { document, loop, propagate, isolated, rooms } = defineProps<{
  document: SpriteDocument;
  loop: number;
  /** Edits change the whole linked group. */
  propagate: boolean;
  /** Loops the last edit split off. */
  isolated: readonly number[];
  /** Rooms that use the view. */
  rooms: readonly number[];
}>();
const emit = defineEmits<{
  /** Edit `loop` with its linked loops together (true) or on its own (false). */
  propagate: [loop: number, on: boolean];
}>();

const names = (loops: readonly number[]): string =>
  loops.length === 1
    ? `loop ${loops[0]}`
    : `loops ${loops.slice(0, -1).join(", ")} and ${loops.at(-1)}`;

const note = computed(() => {
  const group = aliasGroup(document, loop);
  const others = group.filter((member) => member !== loop);
  const owner = group[0]!;
  if (others.length > 0 && propagate)
    return {
      tone: "action",
      text: `Editing loop ${loop} changes ${names(others)} with it: a mirrored loop shows the edit mirrored.`,
      action: { label: `Edit loop ${loop} only`, loop, on: false },
    };
  if (others.length > 0) {
    const relation =
      loop === owner
        ? `${names(others).replace(/^l/, "L")} ${others.length === 1 ? "mirrors" : "mirror"} loop ${loop}.`
        : `Loop ${loop} mirrors loop ${owner}.`;
    return {
      tone: "neutral",
      text: `${relation} Editing loop ${loop} makes it a separate copy; ${names(others)} ${others.length === 1 ? "stays" : "stay"} as ${others.length === 1 ? "it is" : "they are"}.`,
      action:
        loop === owner
          ? { label: "Edit linked loops together", loop, on: true }
          : { label: `Edit loop ${owner} instead`, loop: owner, on: true },
    };
  }
  if (isolated.includes(loop))
    return {
      tone: "ok",
      text: `Loop ${loop} is now a separate copy; the loop it mirrored kept its pixels.`,
      action: null,
    };
  return null;
});
</script>

<template>
  <section
    v-if="note || rooms.length > 1"
    class="mirror-note"
    aria-label="Linked loops"
    data-testid="sprite-mirror-note"
  >
    <p v-if="note" class="mirror-note__text" :class="`is-${note.tone}`" role="status">
      <UiIcon name="link" :size="14" />
      <span data-testid="sprite-mirror-text">{{ note.text }}</span>
    </p>
    <UiButton
      v-if="note?.action"
      size="sm"
      :variant="note.action.on ? 'secondary' : 'ghost'"
      data-testid="sprite-propagate"
      @click="emit('propagate', note.action.loop, note.action.on)"
    >
      {{ note.action.label }}
    </UiButton>
    <p v-if="rooms.length > 1" class="mirror-note__shared" data-testid="sprite-shared-note">
      Rooms {{ rooms.join(", ") }} share this view: a Keep changes it in each of them.
    </p>
  </section>
</template>

<style scoped>
.mirror-note {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  margin: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--action-line);
  border-radius: var(--radius);
  background: var(--action-soft);
  font-size: var(--text-xs);
}
.mirror-note__text {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink);
}
.mirror-note__text .ui-icon {
  flex: none;
  margin-top: 2px;
  color: var(--action);
}
.mirror-note__text.is-ok .ui-icon {
  color: var(--ok);
}
.mirror-note__shared {
  margin: 0;
  color: var(--ink-2);
}
</style>
