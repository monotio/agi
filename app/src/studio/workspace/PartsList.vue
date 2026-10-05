<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch, onWatcherCleanup } from "vue";
import { useEngineApi } from "../../engine/engineContext.ts";
import WorkspaceTip from "../../shell/WorkspaceTip.vue";
import BindingDetails from "../../shell/BindingDetails.vue";
import { workspaceBindingInfos } from "../../shell/workspaceNames.ts";
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
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
const engine = useEngineApi();
const names = shallowRef<BindingInfo[]>([]);
const details = ref<BindingInfo>();
const editingName = ref(false);
const selectedName = computed(
  () =>
    details.value &&
    (names.value.find((info) => info.name === details.value!.name) ?? details.value),
);
const stateNames = computed(() =>
  names.value.filter((info) => ["flag", "variable"].includes(info.kind)),
);
watch(
  () => [engine.state.phase, engine.state.patchTick],
  () => {
    const session = engine.getProjectSession();
    function refresh(): void {
      try {
        names.value = session
          ? workspaceBindingInfos(session.model.capture(), props.profile?.id ?? "2.936")
          : [];
      } catch {
        names.value = [];
      }
    }
    refresh();
    const off = session?.subscribe(refresh);
    onWatcherCleanup(() => off?.());
  },
  { immediate: true },
);
function resourceName(key: string): BindingInfo | undefined {
  return names.value.find((info) => `${info.kind}:${info.num}` === key);
}
function closePartMenu(event: MouseEvent): void {
  const button = event.currentTarget as HTMLButtonElement;
  button.closest("details")?.removeAttribute("open");
}
function renamePart(key: string): void {
  details.value = resourceName(key);
  editingName.value = true;
}
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
    <WorkspaceTip
      id="workspace"
      text="Pick a part to change it. Play your game beside the editor."
    />
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
      <div v-for="row in group.entries" :key="row.id" class="part-row">
        <button
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
          <span>{{
            row.child && resourceName(row.key)
              ? `${resourceName(row.key)!.name.replaceAll("_", " ")} · ${row.key.replace(":", " ").toUpperCase()}`
              : row.label
          }}</span
          ><i v-if="row.live" class="live-dot" aria-label="Hero here"></i>
        </button>
        <details v-if="resourceName(row.key)" class="part-menu">
          <summary :aria-label="`Actions for ${resourceName(row.key)!.name}`">⋯</summary>
          <button
            class="part-rename"
            :title="
              readOnly
                ? 'Editing is paused. Download your unsaved edits, then reload.'
                : 'Rename this part'
            "
            :disabled="readOnly"
            :aria-label="`Rename ${resourceName(row.key)!.name}`"
            @click="
              closePartMenu($event);
              renamePart(row.key);
            "
          >
            Rename
          </button>
        </details>
      </div>
      <section v-if="group.label === 'SHARED LOGIC' && stateNames.length" class="game-state">
        <h2>Game state</h2>
        <div v-for="info in stateNames" :key="info.name" class="state-row">
          <button
            class="part"
            @click="
              details = info;
              editingName = false;
            "
          >
            {{ info.name
            }}<small>{{ info.kind === "flag" ? "Flag" : "Variable" }} {{ info.num }}</small>
          </button>
          <small v-for="role in ['Set', 'Checked'] as const" :key="role"
            >{{ role }}:
            {{
              [
                ...new Set(
                  info.uses
                    .filter((use) => use.role === role)
                    .map((use) => use.key.replace(":", " ").toUpperCase()),
                ),
              ].join(", ") || "nowhere yet"
            }}</small
          >
          <details class="part-menu">
            <summary :aria-label="`Actions for ${info.name}`">⋯</summary>
            <button
              class="part-rename"
              :title="
                readOnly
                  ? 'Editing is paused. Download your unsaved edits, then reload.'
                  : 'Rename this name'
              "
              :disabled="readOnly"
              :aria-label="`Rename ${info.name}`"
              @click="
                closePartMenu($event);
                details = info;
                editingName = true;
              "
            >
              Rename
            </button>
          </details>
        </div>
      </section>
    </section>
    <BindingDetails
      v-if="selectedName"
      :info="selectedName"
      :rename="editingName"
      @close="details = undefined"
      @renamed="
        details = $event;
        editingName = false;
      "
    />
  </nav>
</template>
<style scoped>
.state-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  margin-block: var(--space-2);
}
.state-row .part {
  grid-column: 1 / -1;
  flex-direction: column;
  align-items: flex-start;
}
.state-row small {
  grid-column: 1;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  padding-inline: var(--space-3);
}
.state-row .part-menu {
  grid-column: 2;
  grid-row: 2 / 4;
}
.part-row {
  display: flex;
  align-items: center;
}
.part-row .part {
  flex: 1;
  min-width: 0;
}
.part-rename {
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-sans);
  cursor: pointer;
  padding: var(--space-1);
}
.part-menu {
  position: relative;
  flex: none;
}
.part-menu summary {
  list-style: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-2);
  color: var(--ink-3);
}
.part-menu summary::-webkit-details-marker {
  display: none;
}
.part-menu[open] .part-rename {
  position: absolute;
  z-index: 4;
  right: 0;
  top: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
}
.game-state {
  margin-top: var(--space-3);
}
.parts-list {
  width: 100%;
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
