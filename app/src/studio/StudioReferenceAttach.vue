<script setup lang="ts">
import { computed, inject, ref, useTemplateRef, watch } from "vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { engineKey } from "../engine/engineContext.ts";
import type { StoredReference } from "../references/referenceArt.ts";
import { decodeReferenceFile } from "../references/referenceDecode.ts";

/**
 * Ask's reference art: Attach picks an image (or `attachFile` takes one the
 * Ask section had dropped on it) and stores it with the game as reference
 * art for this room or view, or picks one the game already holds for it.
 * The attached ones show as small chips with their thumbnails, each
 * removable; the model receives them as handles (a manifest line and a
 * thumbnail each) and views what it needs. Removing a chip only leaves it
 * off this request; the art stays with the game. Reference art belongs to a
 * game made or remixed in this browser: elsewhere the control is off and
 * says so.
 */
export interface AttachedReference {
  readonly id: string;
  readonly label: string;
  /** A data URL of the stored image, shown small. */
  readonly thumb: string;
}

const { target, disabled = false } = defineProps<{
  /** The room or view the art is for. */
  target: { readonly kind: "room" | "view"; readonly num: number };
  disabled?: boolean;
}>();
const attached = defineModel<AttachedReference[]>({ required: true });

const engine = inject(engineKey, null);
const input = useTemplateRef("input");
const saved = ref<StoredReference[]>([]);
const busy = ref(false);
const error = ref("");

/** The running game keeps reference art: one made or remixed in this browser. */
const authored = computed(() => {
  const game = engine?.currentGame();
  return !!game && !game.installed && game.projectId !== undefined;
});
const NOT_AUTHORED = "Reference art attaches to a game made or remixed in this browser.";
const off = computed(() => disabled || busy.value || !authored.value);

const forTarget = (reference: StoredReference): boolean =>
  reference.target === target.num &&
  reference.kind === (target.kind === "room" ? "room" : "character");

function labelOf(reference: StoredReference, index: number): string {
  return reference.brief.trim() || `Reference ${index + 1}`;
}
function thumbOf(reference: StoredReference): string {
  const image = reference.images[0]!;
  return `data:${image.mime};base64,${image.png}`;
}
/** The saved art for this room or view that is not attached yet. */
const offered = computed(() =>
  saved.value.filter((reference) => !attached.value.some((chip) => chip.id === reference.id)),
);

async function refresh(): Promise<void> {
  if (!engine || !authored.value) return;
  saved.value = (await engine.listReferences().catch(() => [])).filter(forTarget);
}
watch(() => [target.kind, target.num], refresh, { immediate: true });

function add(reference: StoredReference): void {
  if (attached.value.some((chip) => chip.id === reference.id)) return;
  const index = saved.value.findIndex((entry) => entry.id === reference.id);
  attached.value = [
    ...attached.value,
    {
      id: reference.id,
      label: labelOf(reference, index < 0 ? saved.value.length : index),
      thumb: thumbOf(reference),
    },
  ];
}

/** Store `file` as this room's or view's reference art and attach it. */
async function attachFile(file: File): Promise<void> {
  if (!engine || off.value) return;
  busy.value = true;
  error.value = "";
  try {
    const decoded = await decodeReferenceFile(file);
    const reference = await engine.attachStudioReference(decoded, target, "");
    await refresh();
    add(reference);
  } catch (failure) {
    error.value = String(failure instanceof Error ? failure.message : failure);
  } finally {
    busy.value = false;
  }
}

function pick(event: Event): void {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  element.value = "";
  if (file) void attachFile(file);
}
function remove(id: string): void {
  attached.value = attached.value.filter((chip) => chip.id !== id);
}
function choose(): void {
  input.value?.click();
}

defineExpose({ attachFile });
</script>

<template>
  <div v-if="engine" class="ref-attach" data-testid="assist-references">
    <input
      ref="input"
      class="ref-attach__file"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      tabindex="-1"
      aria-hidden="true"
      data-testid="assist-reference-file"
      @change="pick"
    />
    <ul v-if="attached.length" class="ref-attach__chips" aria-label="Attached references">
      <li
        v-for="chip in attached"
        :key="chip.id"
        class="ref-attach__chip"
        :data-reference="chip.id"
        data-testid="assist-reference-chip"
      >
        <img
          class="ref-attach__thumb"
          :src="chip.thumb"
          alt=""
          data-testid="assist-reference-thumb"
        />
        <span class="ref-attach__label">{{ chip.label }}</span>
        <UiIconButton
          icon="x"
          size="sm"
          :label="`Remove ${chip.label}`"
          data-testid="assist-reference-remove"
          @click="remove(chip.id)"
        />
      </li>
    </ul>
    <ActionMenu v-if="offered.length && !off" label="Attach" test-id="assist-reference-menu">
      <button type="button" role="menuitem" data-testid="assist-reference-upload" @click="choose">
        Choose an image…
      </button>
      <div role="separator"></div>
      <button
        v-for="(reference, index) in offered"
        :key="reference.id"
        type="button"
        role="menuitem"
        class="ref-attach__saved"
        :data-testid="`assist-reference-saved-${reference.id}`"
        @click="add(reference)"
      >
        <img class="ref-attach__thumb" :src="thumbOf(reference)" alt="" />
        {{ labelOf(reference, saved.indexOf(reference) < 0 ? index : saved.indexOf(reference)) }}
      </button>
    </ActionMenu>
    <UiButton
      v-else
      size="sm"
      variant="ghost"
      icon="image"
      :disabled="off"
      :title="authored ? 'Attach a reference image' : NOT_AUTHORED"
      data-testid="assist-reference-attach"
      @click="choose"
    >
      {{ busy ? "Attaching…" : "Attach" }}
    </UiButton>
    <p v-if="error" class="ref-attach__error" role="alert" data-testid="assist-reference-error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.ref-attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.ref-attach__file {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.ref-attach__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ref-attach__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
  padding: 0 0 0 var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-2);
  background: var(--surface-2);
  font-size: var(--text-xs);
}
.ref-attach__thumb {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: var(--radius-sm);
  object-fit: cover;
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.ref-attach__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref-attach__saved {
  gap: var(--space-2);
}
.ref-attach__error {
  width: 100%;
  margin: 0;
  color: var(--warn);
  font-size: var(--text-xs);
}
</style>
