<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import ViewThumbnail from "./ViewThumbnail.vue";
import UiExplain from "../../ui/UiExplain.vue";
import type { WorkspacePartGroup } from "../host/workspaceParts.ts";
const props = defineProps<{
  readOnly?: boolean;
  groups: readonly WorkspacePartGroup[];
  selected: string | undefined;
  thumbnails: Readonly<Record<string, string>>;
  views?: Readonly<Record<string, Uint8Array>>;
  profile?: AgiProfile;
  addGroups?: readonly string[];
}>();
const emit = defineEmits<{ open: [key: string]; pin: [key: string]; add: [group: string] }>();
const root = useTemplateRef("root");
const focused = ref("");
const rows = computed(() => props.groups.flatMap((group) => group.entries));
const roving = computed(
  () =>
    rows.value.find((row) => row.id === focused.value)?.id ??
    rows.value.find((row) => row.key === props.selected)?.id ??
    rows.value[0]?.id,
);
let search = "";
let lastKey = 0;
function onKey(event: KeyboardEvent): void {
  const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>("[data-part-row]") ?? [])];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number | undefined;
  if (event.key === "ArrowDown") next = Math.min(index + 1, buttons.length - 1);
  else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key !== " "
  ) {
    search = (Date.now() - lastKey > 700 ? "" : search) + event.key.toLowerCase();
    lastKey = Date.now();
    for (let offset = 1; offset <= rows.value.length; offset++) {
      const at = (index + offset) % rows.value.length;
      if (rows.value[at]?.label.toLowerCase().startsWith(search)) {
        next = at;
        break;
      }
    }
  } else return;
  event.preventDefault();
  if (next !== undefined) buttons[next]?.focus();
}
</script>
<template>
  <nav
    ref="root"
    class="parts-list"
    aria-label="Parts list"
    data-testid="parts-list"
    @keydown="onKey"
  >
    <section v-for="group in groups" :key="group.label">
      <header>
        <h2>
          <UiExplain
            :term="`parts-${group.label.toLowerCase().replaceAll(' ', '-')}`"
            :name="group.label"
            :says="group.help"
            >{{ group.label }}</UiExplain
          >
        </h2>
        <button
          v-if="
            (
              addGroups ?? [
                'ROOMS',
                'SHARED LOGIC',
                'PICTURES',
                'VIEWS',
                'SOUNDS',
                'OBJECTS',
                'WORDS',
              ]
            ).includes(group.label)
          "
          type="button"
          class="parts-add"
          :disabled="readOnly"
          :title="readOnly ? 'Editing is paused. Download your unsaved edits, then reload.' : ''"
          :aria-label="`Add ${group.label === 'ROOMS' ? 'a room' : group.label === 'SHARED LOGIC' ? 'shared logic' : group.label === 'PICTURES' ? 'a picture' : group.label === 'VIEWS' ? 'a view' : group.label === 'OBJECTS' ? 'an object' : group.label === 'WORDS' ? 'a word' : 'a sound'}`"
          @click="emit('add', group.label)"
        >
          +
        </button>
      </header>
      <button
        v-for="row in group.entries"
        :key="row.id"
        type="button"
        class="part"
        :class="{ 'part--child': row.child, 'part--selected': row.key === selected }"
        :tabindex="roving === row.id ? 0 : -1"
        :aria-current="row.key === selected ? 'true' : undefined"
        :data-part-row="row.id"
        :data-testid="`part-${row.id}`"
        @focus="focused = row.id"
        @click="emit('open', row.key)"
        @dblclick="emit('pin', row.key)"
      >
        <img v-if="thumbnails[row.id]" :src="thumbnails[row.id]" alt="" />
        <ViewThumbnail
          v-if="views?.[row.key] && profile"
          :bytes="views[row.key]!"
          :profile="profile"
        />
        <span>{{ row.label }}</span
        ><i v-if="row.live" class="live-dot" aria-label="Hero here"></i>
      </button>
    </section>
  </nav>
</template>
<style scoped>
.parts-list {
  width: 252px;
  min-width: 0;
  overflow: auto;
  border-right: 1px solid var(--hairline);
  background: var(--surface-1);
  padding: var(--space-4) var(--space-2);
  box-sizing: border-box;
}
section + section {
  margin-top: var(--space-5);
}
header {
  display: flex;
  align-items: center;
  padding: 0 var(--space-2);
  gap: var(--space-1);
}
h2 {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
}
.parts-add {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: var(--text-lg);
  cursor: pointer;
}
.part {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-h-sm);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--ink-2);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.part:hover {
  background: var(--surface-3);
  color: var(--ink);
}
.part--selected {
  background: var(--action-soft);
  color: var(--ink);
}
.part--child {
  padding-left: var(--space-8);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.part img {
  width: 44px;
  height: 32px;
  object-fit: contain;
  image-rendering: pixelated;
  background: var(--agi-0);
  border-radius: var(--radius-sm);
}
.part > span:not(.view-thumbnail) {
  flex: 1;
  min-width: 0;
}
.live-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--ok);
}
</style>
