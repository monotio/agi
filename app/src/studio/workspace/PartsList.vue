<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import {
  computed,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
  onWatcherCleanup,
  nextTick,
  onMounted,
} from "vue";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import BindingDetails from "../../shell/BindingDetails.vue";
import {
  renameBindingInWorkspace,
  workspaceBindingInfos,
  workspaceGameStateInfos,
  type ReservedStateInfo,
} from "../../shell/workspaceNames.ts";
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import ViewThumbnail from "./ViewThumbnail.vue";
import UiExplain from "../../ui/UiExplain.vue";
import UiButton from "../../ui/UiButton.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import type { WorkspacePartGroup } from "../host/workspaceParts.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import {
  sameProjectContent,
  type ProjectContent,
} from "../../../../src/authoring/projectContent.ts";
const props = defineProps<{
  active?: boolean;
  readOnly?: boolean;
  groups: readonly WorkspacePartGroup[];
  selected: string | undefined;
  pending?: readonly string[];
  bindings?: string | undefined;
  thumbnails: Readonly<Record<string, string>>;
  views?: Readonly<Record<string, Uint8Array>>;
  profile?: AgiProfile;
  addGroups?: readonly string[];
  /** A room whose name is being edited in place (a fresh add starts there). */
  renameRoom?: number | undefined;
}>();
const emit = defineEmits<{
  open: [key: string, room?: number];
  add: [group: string, option?: string];
  nameState: [kind: "flag" | "variable", num: number, name: string];
  rename: [room: number, title: string];
  renameCancel: [];
}>();
const engine = useEngineApi();
const workspace = useWorkspaceEditor();
const acceptedNames = shallowRef<BindingInfo[]>([]);
const builtinNames = shallowRef<ReservedStateInfo[]>([]);
const names = computed(() => {
  if (props.bindings === undefined) return acceptedNames.value;
  try {
    return Object.entries(readBindingsDocument(props.bindings))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, binding]) => ({
        name,
        ...binding,
        uses:
          acceptedNames.value.find((info) => info.kind === binding.kind && info.num === binding.num)
            ?.uses ?? [],
      }));
  } catch {
    return acceptedNames.value;
  }
});
const details = ref<BindingInfo>();
/**
 * In-place renaming of a name: ⋯ › Rename or a double-click turns the row's
 * name into a field. Enter keeps the new name, Esc puts the old one back and
 * leaving a changed name keeps it.
 */
const renaming = ref<{ row: string; name: string }>();
const renameValue = ref("");
const renameError = ref("");
const renameBusy = ref(false);
const nameInput = useTemplateRef("nameInput");
function startRename(row: string, name: string): void {
  if (props.readOnly) return;
  details.value = undefined;
  renaming.value = { row, name };
  renameValue.value = name;
  renameError.value = "";
}
watch(
  [renaming, nameInput],
  ([current, element], [previous]) => {
    // A ref inside v-for collects an array; one name field shows at a time.
    const target = Array.isArray(element) ? element[0] : element;
    if (!target || current === previous) return;
    target.focus();
    target.select();
  },
  { flush: "post" },
);
function cancelRename(): void {
  renaming.value = undefined;
  renameError.value = "";
}
async function commitRename(): Promise<void> {
  const current = renaming.value;
  if (!current || renameBusy.value) return;
  const next = renameValue.value.trim();
  if (!next || next === current.name) {
    cancelRename();
    return;
  }
  if (names.value.some((info) => info.name === next)) {
    renameError.value = "That name is taken. Choose another.";
    return;
  }
  renameBusy.value = true;
  renameError.value = "";
  try {
    await renameBindingInWorkspace(engine, workspace.flush.value, current.name, next);
    if (renaming.value === current) renaming.value = undefined;
  } catch (cause) {
    renameError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    renameBusy.value = false;
  }
}
function enterRename(event: KeyboardEvent): void {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void commitRename();
}
/** Leaving the field keeps a changed name; an unchanged one closes the field. */
function blurName(): void {
  if (!renaming.value || renameBusy.value) return;
  if (renameValue.value.trim() === renaming.value.name) cancelRename();
  else void commitRename();
}
/** The Game state + row: name a flag or variable in place. */
const namingOpen = ref(false);
const namingKind = ref<"flag" | "variable">("flag");
const namingNum = ref(0);
const namingName = ref("");
const namingError = ref("");
const nextFree = computed(() => {
  const used = new Set(
    names.value.filter((info) => info.kind === namingKind.value).map((info) => info.num),
  );
  let num = 16;
  while (used.has(num) && num < 256) num++;
  return num;
});
function openNaming(): void {
  namingOpen.value = true;
  namingNum.value = nextFree.value;
  namingName.value = "";
  namingError.value = "";
}
function nameState(): void {
  const name = namingName.value.trim();
  if (!name) {
    namingError.value = "Give it a name first.";
    return;
  }
  if (names.value.some((info) => info.name === name)) {
    namingError.value = "That name is taken.";
    return;
  }
  emit("nameState", namingKind.value, namingNum.value, name);
  namingOpen.value = false;
}
const sharedOpen = ref(false);
function sectionAdd(label: string): void {
  if (label === "GAME STATE") openNaming();
  else if (label === "SHARED LOGIC") sharedOpen.value = !sharedOpen.value;
  else emit("add", label);
}
function addShared(option: string): void {
  sharedOpen.value = false;
  emit("add", "SHARED LOGIC", option);
}
const selectedName = computed(
  () =>
    details.value &&
    (names.value.find((info) => info.name === details.value!.name) ?? details.value),
);
const stateNames = computed(() =>
  names.value.filter((info) => ["flag", "variable"].includes(info.kind)),
);
const creatorNames = computed(() =>
  stateNames.value.filter(
    (info) =>
      !builtinNames.value.some(
        (reserved) =>
          reserved.name === info.name && reserved.kind === info.kind && reserved.num === info.num,
      ),
  ),
);
/** In-place room naming: a fresh add pre-fills "Room N" selected, typing replaces it. */
const editingRoomLocal = ref<number>();
const editingRoom = computed(() => editingRoomLocal.value ?? props.renameRoom);
const roomTitle = ref("");
const renameInput = useTemplateRef("renameInput");
function roomLabel(room: number): string {
  const row = props.groups
    .flatMap((group) => group.entries)
    .find((row) => row.id === `room:${room}`);
  return row?.label.split(" · ROOM ")[0] || `Room ${room}`;
}
function startRoomRename(room: number): void {
  roomTitle.value = roomLabel(room);
  editingRoomLocal.value = room;
}
watch(
  () => props.renameRoom,
  (room) => {
    if (room !== undefined) roomTitle.value = roomLabel(room);
  },
  { immediate: true },
);
watch(
  [editingRoom, renameInput],
  ([, element]) => {
    // A ref inside v-for collects an array; one rename form shows at a time.
    const target = Array.isArray(element) ? element[0] : element;
    if (!target) return;
    target.focus();
    target.select();
  },
  { flush: "post" },
);
function commitRoomRename(room: number): void {
  if (editingRoom.value === undefined) return;
  const title = roomTitle.value.trim();
  editingRoomLocal.value = undefined;
  if (title) emit("rename", room, title);
  else emit("renameCancel");
}
function enterRoomRename(event: KeyboardEvent, room: number): void {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  commitRoomRename(room);
}
function cancelRoomRename(): void {
  editingRoomLocal.value = undefined;
  emit("renameCancel");
}
/** Leaving a typed name commits it; a fresh default stays ready for naming. */
function blurRename(room: number): void {
  if (editingRoomLocal.value !== undefined || roomTitle.value.trim() !== roomLabel(room))
    commitRoomRename(room);
}
watch(
  () => [engine.state.phase, engine.state.patchTick],
  () => {
    const session = engine.getProjectSession();
    let previousInputs: Record<string, ProjectContent | undefined> | undefined;
    let previousProfile: string | undefined;
    function refresh(): void {
      try {
        const snapshot = session?.workingSnapshot();
        const profile = props.profile?.id ?? "2.936";
        const inputs = Object.fromEntries(
          (snapshot?.keys ?? [])
            .filter((key) => key === "bindings" || key === "words" || key.startsWith("logic:"))
            .map((key) => [key, snapshot?.read(key)?.content]),
        );
        // Save notifications and art edits keep the same name inputs. Avoid
        // rebuilding the whole LOGIC operand index for those notifications.
        const previous = previousInputs;
        if (
          previous !== undefined &&
          previousProfile === profile &&
          Object.keys(previous).length === Object.keys(inputs).length &&
          Object.entries(inputs).every(
            ([key, content]) =>
              Object.hasOwn(previous, key) && sameProjectContent(previous[key], content),
          )
        )
          return;
        acceptedNames.value = snapshot ? workspaceBindingInfos(snapshot, profile) : [];
        builtinNames.value = snapshot ? workspaceGameStateInfos(snapshot, profile).builtin : [];
        previousInputs = inputs;
        previousProfile = profile;
      } catch {
        previousInputs = undefined;
        acceptedNames.value = [];
        builtinNames.value = [];
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
const root = useTemplateRef("root");
function rememberScroll(): void {
  if (props.active !== false) workspace.partsScroll.value = root.value?.scrollTop ?? 0;
}
async function restoreScroll(): Promise<void> {
  await nextTick();
  if (root.value) root.value.scrollTop = workspace.partsScroll.value;
}
onMounted(restoreScroll);
watch(
  () => props.active,
  (active) => {
    if (active !== false) void restoreScroll();
  },
);
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
    @scroll="rememberScroll"
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
                'GAME STATE',
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
          :data-testid="group.label === 'GAME STATE' ? 'add-game-state' : undefined"
          :title="readOnly ? 'Editing is paused. Download your unsaved edits, then reload.' : ''"
          :aria-label="`Add ${group.label === 'GAME STATE' ? 'a flag or variable' : group.label === 'ROOMS' ? 'a room' : group.label === 'SHARED LOGIC' ? 'shared logic' : group.label === 'PICTURES' ? 'a picture' : group.label === 'VIEWS' ? 'a view' : group.label === 'OBJECTS' ? 'an object' : group.label === 'WORDS' ? 'a word' : 'a sound'}`"
          @click="sectionAdd(group.label)"
        >
          +
        </button>
      </header>
      <div
        v-if="group.label === 'SHARED LOGIC' && sharedOpen"
        class="shared-add"
        role="menu"
        aria-label="Shared code"
        data-testid="shared-add"
        @keydown.esc.stop="sharedOpen = false"
      >
        <button type="button" role="menuitem" @click="addShared('menus')">
          Menus and Save/Restore
        </button>
        <button type="button" role="menuitem" @click="addShared('game-over')">Game over</button>
        <button type="button" role="menuitem" @click="addShared('score')">Score screen</button>
        <button type="button" role="menuitem" @click="addShared('empty')">Empty shared code</button>
      </div>
      <div v-for="row in group.entries" :key="row.id" class="part-row">
        <form
          v-if="row.id === `room:${row.room}` && editingRoom === row.room"
          class="part part-rename-form"
          data-testid="room-rename-form"
          @submit.prevent="commitRoomRename(row.room!)"
        >
          <input
            ref="renameInput"
            v-model="roomTitle"
            data-testid="room-rename-input"
            aria-label="Room name"
            maxlength="160"
            @focus="($event.target as HTMLInputElement).select()"
            @keydown.enter="enterRoomRename($event, row.room!)"
            @keydown.esc.stop="cancelRoomRename"
            @blur="blurRename(row.room!)"
          />
        </form>
        <input
          v-else-if="renaming?.row === `part:${row.id}`"
          ref="nameInput"
          v-model="renameValue"
          class="part part-name-input"
          :class="{ 'part--child': row.child }"
          :aria-label="`New name for ${renaming.name}`"
          :aria-invalid="renameError ? 'true' : undefined"
          maxlength="64"
          :readonly="renameBusy"
          @keydown.enter="enterRename"
          @keydown.esc.stop.prevent="cancelRename"
          @blur="blurName"
        />
        <button
          v-else
          type="button"
          class="part"
          :class="{ 'part--child': row.child, 'part--selected': row.key === selected }"
          :tabindex="roving === row.id ? 0 : -1"
          :aria-current="row.key === selected ? 'true' : undefined"
          :data-part-row="row.id"
          :data-testid="`part-${row.id}`"
          @focus="focused = row.id"
          @click="emit('open', row.key, row.room)"
          @dblclick.stop.prevent="
            row.id === `room:${row.room}`
              ? !readOnly && startRoomRename(row.room!)
              : resourceName(row.key) && startRename(`part:${row.id}`, resourceName(row.key)!.name)
          "
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
          ><i v-if="pending?.includes(row.key)" class="draft-dot" aria-label="Pending change"></i
          ><i v-if="row.live" class="live-dot" aria-label="Hero here"></i>
        </button>
        <details v-if="row.id === `room:${row.room}`" class="part-menu">
          <summary :aria-label="`Actions for ${roomLabel(row.room!)}`">
            <UiIcon name="ellipsis" :size="16" />
          </summary>
          <button
            class="part-rename"
            :title="
              readOnly
                ? 'Editing is paused. Download your unsaved edits, then reload.'
                : 'Rename this room'
            "
            :disabled="readOnly"
            :aria-label="`Rename ${roomLabel(row.room!)}`"
            @click="
              closePartMenu($event);
              startRoomRename(row.room!);
            "
          >
            Rename
          </button>
        </details>
        <details v-else-if="resourceName(row.key)" class="part-menu">
          <summary :aria-label="`Actions for ${resourceName(row.key)!.name}`">
            <UiIcon name="ellipsis" :size="16" />
          </summary>
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
              startRename(`part:${row.id}`, resourceName(row.key)!.name);
            "
          >
            Rename
          </button>
        </details>
        <p
          v-if="renaming?.row === `part:${row.id}` && renameError"
          class="part-name-error"
          role="alert"
        >
          {{ renameError }}
        </p>
      </div>
      <form
        v-if="group.label === 'GAME STATE' && namingOpen"
        class="game-state-naming"
        data-testid="game-state-naming"
        @submit.prevent="nameState"
      >
        <div class="game-state-naming__row">
          <UiSegmented
            v-model="namingKind"
            label="Kind"
            :options="[
              { value: 'flag', label: 'Flag' },
              { value: 'variable', label: 'Variable' },
            ]"
          />
        </div>
        <div class="game-state-naming__row">
          <input
            v-model.number="namingNum"
            type="number"
            min="0"
            max="255"
            data-testid="game-state-num"
            :aria-label="namingKind === 'flag' ? 'Flag number' : 'Variable number'"
          />
          <input
            v-model="namingName"
            data-testid="game-state-name"
            aria-label="Name"
            placeholder="name_it_like_this"
          />
        </div>
        <p v-if="namingError" class="game-state-naming__error" role="alert">{{ namingError }}</p>
        <div class="game-state-naming__row">
          <UiButton size="sm" type="submit">Rename</UiButton>
          <UiButton size="sm" variant="ghost" @click="namingOpen = false">Cancel</UiButton>
        </div>
      </form>
      <section
        v-if="group.label === 'GAME STATE' && (stateNames.length || builtinNames.length)"
        class="game-state"
      >
        <div v-for="info in creatorNames" :key="info.name" class="state-row">
          <input
            v-if="renaming?.row === `state:${info.name}`"
            ref="nameInput"
            v-model="renameValue"
            class="part part-name-input"
            :aria-label="`New name for ${info.name}`"
            :aria-invalid="renameError ? 'true' : undefined"
            maxlength="64"
            :readonly="renameBusy"
            @keydown.enter="enterRename"
            @keydown.esc.stop.prevent="cancelRename"
            @blur="blurName"
          />
          <button
            v-else
            class="part"
            @click="details = info"
            @dblclick.stop.prevent="startRename(`state:${info.name}`, info.name)"
          >
            {{ info.name
            }}<small>{{ info.kind === "flag" ? "Flag" : "Variable" }} {{ info.num }}</small>
          </button>
          <p
            v-if="renaming?.row === `state:${info.name}` && renameError"
            class="part-name-error"
            role="alert"
          >
            {{ renameError }}
          </p>
          <ActionMenu
            class="state-actions"
            :label="`Actions for ${info.name}`"
            icon-only
            icon="ellipsis"
            size="sm"
          >
            <button type="button" role="menuitem" @click="details = info">Find references</button>
            <button
              type="button"
              role="menuitem"
              :disabled="readOnly"
              :title="
                readOnly
                  ? 'Editing is paused. Download your unsaved edits, then reload.'
                  : 'Rename this name'
              "
              :aria-label="`Rename ${info.name}`"
              @click="startRename(`state:${info.name}`, info.name)"
            >
              Rename
            </button>
          </ActionMenu>
        </div>
        <details
          v-if="builtinNames.length"
          class="game-state-builtin"
          data-testid="game-state-builtin"
        >
          <summary>Built-in</summary>
          <div v-for="info in builtinNames" :key="info.name" class="state-row">
            <input
              v-if="renaming?.row === `builtin:${info.name}`"
              ref="nameInput"
              v-model="renameValue"
              class="part part-name-input"
              :aria-label="`New name for ${info.name}`"
              :aria-invalid="renameError ? 'true' : undefined"
              maxlength="64"
              :readonly="renameBusy"
              @keydown.enter="enterRename"
              @keydown.esc.stop.prevent="cancelRename"
              @blur="blurName"
            />
            <button
              v-else
              class="part"
              @click="details = info"
              @dblclick.stop.prevent="startRename(`builtin:${info.name}`, info.name)"
            >
              <span>{{ info.name }}</span
              ><small>{{ info.kind === "flag" ? "Flag" : "Variable" }} {{ info.num }}</small>
            </button>
            <p
              v-if="renaming?.row === `builtin:${info.name}` && renameError"
              class="part-name-error"
              role="alert"
            >
              {{ renameError }}
            </p>
            <small>{{ info.meaning }}</small>
            <small v-if="info.usage">Used: {{ info.usage }}</small>
            <ActionMenu
              class="state-actions"
              :label="`Actions for ${info.name}`"
              icon-only
              icon="ellipsis"
              size="sm"
            >
              <button type="button" role="menuitem" @click="details = info">Find references</button>
              <button
                type="button"
                role="menuitem"
                :disabled="readOnly"
                :title="
                  readOnly
                    ? 'Editing is paused. Download your unsaved edits, then reload.'
                    : 'Rename this name'
                "
                :aria-label="`Rename ${info.name}`"
                @click="startRename(`builtin:${info.name}`, info.name)"
              >
                Rename
              </button>
            </ActionMenu>
          </div>
        </details>
      </section>
    </section>
    <BindingDetails
      v-if="selectedName"
      :info="selectedName"
      @close="details = undefined"
      @renamed="details = $event"
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
  grid-column: 1;
  flex-direction: column;
  align-items: flex-start;
}
.state-row small {
  grid-column: 1;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  padding-inline: var(--space-3);
}
.state-actions {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}
.part-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.part.part-name-input {
  cursor: text;
  border: 1px solid var(--focus);
  background: var(--surface-0);
  color: var(--ink);
  outline: none;
}
.part-name-error {
  flex-basis: 100%;
  grid-column: 1 / -1;
  margin: var(--space-1) 0 0;
  padding-inline: var(--space-3);
  color: var(--warn);
  font-size: var(--text-xs);
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
.part-rename-form {
  padding: 0;
}
.part-rename-form input {
  width: 100%;
  box-sizing: border-box;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  padding: 0;
  outline: none;
}
.game-state-builtin {
  margin-top: var(--space-3);
}
.game-state-builtin > summary {
  cursor: pointer;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-inline: var(--space-1);
}
.shared-add {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-1);
}
.shared-add button {
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  cursor: pointer;
}
.shared-add button:hover,
.shared-add button:focus-visible {
  background: var(--action-soft);
}
.game-state-naming {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-0);
}
.game-state-naming__row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.game-state-naming__row input {
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  color: var(--ink);
}
.game-state-naming__row input[type="number"] {
  width: 64px;
}
.game-state-naming__error {
  margin: 0;
  color: var(--warn);
  font-size: var(--text-xs);
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
.draft-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--action);
}
.live-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--ok);
}
</style>
