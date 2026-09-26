<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { useOptionalCreateCenter } from "../shell/useCreateWorkspace.ts";
import UiButton from "../ui/UiButton.vue";
import type { StudioDraft } from "./useStudioDraft.ts";
import type { useStudioKeep } from "./useStudioKeep.ts";

/**
 * Room Studio on a layout too small for it (a phone-width window, a rotated
 * phone) while it holds unkept changes: Studio stays mounted with its draft
 * and history, and this full-screen modal covers it. Widening the window or
 * rotating back closes the notice and editing continues; Keep or Discard
 * settles the changes here and leaves Studio. Esc does not dismiss it, and
 * no key reaches the studio or the game behind it.
 */
const { draft, keeper } = defineProps<{
  draft: StudioDraft;
  keeper: ReturnType<typeof useStudioKeep>;
}>();
const emit = defineEmits<{ close: [] }>();
const center = useOptionalCreateCenter();
/** The shell's layout cannot host Studio (never outside the shell, as in the harness). */
const open = computed(() => center?.studioFits.value === false);
const changes = computed(() => draft.changes.value);
const dialog = useTemplateRef("dialog");

async function keep(): Promise<void> {
  if (await keeper.keep()) emit("close");
}
function discard(): void {
  draft.discard();
  emit("close");
}

watch(
  open,
  async (value) => {
    await nextTick();
    const element = dialog.value;
    if (!element) return;
    if (value && !element.open) element.showModal();
    else if (!value && element.open) element.close();
  },
  { immediate: true },
);
</script>

<template>
  <dialog
    ref="dialog"
    class="small-screen"
    aria-labelledby="studio-small-screen-title"
    data-testid="studio-small-screen"
    @cancel.prevent
    @keydown.stop
    @keyup.stop
    @keypress.stop
  >
    <div class="small-screen__card">
      <h2 id="studio-small-screen-title" class="small-screen__title">
        Room Studio needs a larger screen
      </h2>
      <p class="small-screen__text">
        Your unkept changes are safe — widen the window or rotate back to continue.
      </p>
      <p class="small-screen__meta">
        {{ changes }} unkept {{ changes === 1 ? "change" : "changes" }}
      </p>
      <p v-if="keeper.banner.value" class="small-screen__error" role="alert">
        {{ keeper.banner.value.message }}
      </p>
      <div class="small-screen__actions">
        <UiButton variant="danger" data-testid="studio-small-discard" @click="discard">
          Discard
        </UiButton>
        <!-- Focus starts on Keep: the answer that loses nothing. -->
        <UiButton
          variant="primary"
          :disabled="!keeper.canKeep.value"
          :autofocus="keeper.canKeep.value"
          data-testid="studio-small-keep"
          @click="keep"
        >
          Keep
        </UiButton>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.small-screen {
  box-sizing: border-box;
  width: 100vw;
  max-width: none;
  height: 100dvh;
  max-height: none;
  margin: 0;
  padding: var(--space-5);
  border: 0;
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.small-screen[open] {
  display: grid;
  place-items: center;
}
.small-screen::backdrop {
  background: var(--surface-1);
}
.small-screen__card {
  display: grid;
  gap: var(--space-4);
  max-width: 26rem;
}
.small-screen__title {
  margin: 0;
  font: var(--weight-semibold) var(--text-xl) / var(--leading-tight) var(--font-sans);
}
.small-screen__text {
  margin: 0;
  color: var(--ink-2);
}
.small-screen__meta {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) var(--font-mono);
}
.small-screen__error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-soft);
}
.small-screen__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
</style>
