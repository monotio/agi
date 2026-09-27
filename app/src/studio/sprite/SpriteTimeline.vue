<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue";
import UiIcon from "../../ui/UiIcon.vue";
import { sameDisplay, type SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import { mirroredCel } from "../../../../src/studio/sprite/spriteCels.ts";
import type { SpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import SpriteThumb from "../../world/SpriteThumb.vue";
import { aliasGroup, loopFacing } from "./spriteView.ts";

/**
 * The loops × cels timeline. Each loop is a row of its cels; a loop that
 * shares another's data block (a mirror) is a hatched linked row with a
 * "mirror of N" chip. Cels are added, duplicated, reordered, flipped and
 * deleted, and loops added, duplicated, deleted, unlinked and linked, from
 * the context menu (right-click, the Menu key or Shift+F10) or keys on the
 * focused cel; dragging a cel reorders it within its loop and Alt-drag
 * copies it, with Alt+←/→ as the keyboard way. "Copy to loop…" and "Move to
 * loop…" in the menu open a loop picker in its place (arrows, Enter; Esc
 * closes it), the keyboard's way to Alt-drag across loops; a cel lands at
 * the end of the chosen loop, and a move is its copy and the delete as one
 * undo step. Every change goes through the kernel and its dependency checks
 * in the studio.
 *
 * Keys on a cel: ←/→ the neighbouring cel, ↑/↓ the neighbouring loop,
 * Alt+←/→ move the cel, Delete delete it, Cmd/Ctrl+D duplicate it, + add a
 * blank cel after it.
 */
const { document, loop, cel, frozen } = defineProps<{
  document: SpriteDocument;
  loop: number;
  cel: number;
  frozen: boolean;
}>();
const emit = defineEmits<{
  select: [loop: number, cel: number];
  edit: [op: SpriteEdit, label: string];
  /** Edits made as one undo step. */
  edits: [ops: SpriteEdit[], label: string];
}>();

const root = useTemplateRef("root");
const loops = computed(() =>
  document.loops.map((entry, index) => ({
    index,
    alias: entry.alias,
    linked: aliasGroup(document, index).length > 1,
    facing: loopFacing(index, document.loops.length),
    cels: entry.cels,
  })),
);

function focusCel(target: number, index: number): void {
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>(`[data-loop="${target}"][data-cel="${index}"]`)?.focus(),
  );
}
function select(target: number, index: number, focus = false): void {
  emit("select", target, index);
  if (focus) focusCel(target, index);
}

// ---- edits ---------------------------------------------------------------

function edit(op: SpriteEdit, label: string): void {
  if (!frozen) emit("edit", op, label);
}
const duplicateCel = (l: number, c: number) => {
  edit({ type: "addCel", loop: l, at: c + 1, from: { loop: l, cel: c } }, "Duplicate cel");
  select(l, c + 1, true);
};
const addBlank = (l: number, at: number) => {
  edit({ type: "addCel", loop: l, at, from: "blank" }, "Add cel");
  select(l, at, true);
};
const deleteCel = (l: number, c: number) => {
  edit({ type: "deleteCel", loop: l, cel: c }, "Delete cel");
  select(l, Math.max(0, Math.min(c, (document.loops[l]?.cels.length ?? 1) - 2)), true);
};
const moveCel = (l: number, c: number, to: number) => {
  const count = document.loops[l]?.cels.length ?? 0;
  if (to < 0 || to >= count || to === c) return;
  edit({ type: "moveCel", loop: l, cel: c, to }, "Move cel");
  select(l, to, true);
};
const copyCel = (from: { loop: number; cel: number }, l: number, at: number) => {
  edit({ type: "addCel", loop: l, at, from }, "Copy cel");
  select(l, at, true);
};
/** Move a cel to the end of another loop: its copy there, then the delete here. */
const moveToLoop = (l: number, c: number, target: number) => {
  if (frozen || target === l) return;
  const at = document.loops[target]?.cels.length ?? 0;
  emit(
    "edits",
    [
      { type: "addCel", loop: target, at, from: { loop: l, cel: c } },
      { type: "deleteCel", loop: l, cel: c },
    ],
    "Move cel to loop",
  );
  select(target, at, true);
};

// ---- keys ----------------------------------------------------------------

function onCelKey(event: KeyboardEvent, l: number, c: number): void {
  const count = document.loops[l]?.cels.length ?? 0;
  const command = event.metaKey || event.ctrlKey;
  const handled = (): void => event.preventDefault();
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    handled();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(box.left, box.bottom, l, c);
  } else if (event.altKey && event.key === "ArrowLeft") {
    handled();
    moveCel(l, c, c - 1);
  } else if (event.altKey && event.key === "ArrowRight") {
    handled();
    moveCel(l, c, c + 1);
  } else if (event.key === "ArrowLeft" && !command) {
    handled();
    select(l, (c - 1 + count) % count, true);
  } else if (event.key === "ArrowRight" && !command) {
    handled();
    select(l, (c + 1) % count, true);
  } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !command) {
    handled();
    const next = (l + (event.key === "ArrowUp" ? -1 : 1) + loops.value.length) % loops.value.length;
    select(next, Math.min(c, (document.loops[next]?.cels.length ?? 1) - 1), true);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    handled();
    deleteCel(l, c);
  } else if (command && event.key.toLowerCase() === "d") {
    handled();
    duplicateCel(l, c);
  } else if (event.key === "+" && !command) {
    handled();
    addBlank(l, c + 1);
  }
}

// ---- drag ----------------------------------------------------------------

const DRAG_START = 4;
const drag = shallowRef<{
  loop: number;
  cel: number;
  x: number;
  y: number;
  moving: boolean;
  copy: boolean;
  over: { loop: number; at: number } | null;
} | null>(null);

function dropTarget(event: PointerEvent): { loop: number; at: number } | null {
  const hit = globalThis.document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>("[data-drop-loop]");
  if (!hit) return null;
  return { loop: Number(hit.dataset["dropLoop"]), at: Number(hit.dataset["dropAt"]) };
}
function onCelDown(event: PointerEvent, l: number, c: number): void {
  if (event.button !== 0) return;
  select(l, c);
  drag.value = {
    loop: l,
    cel: c,
    x: event.clientX,
    y: event.clientY,
    moving: false,
    copy: false,
    over: null,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onCelMove(event: PointerEvent): void {
  const d = drag.value;
  if (!d) return;
  const moving = d.moving || Math.hypot(event.clientX - d.x, event.clientY - d.y) >= DRAG_START;
  drag.value = { ...d, moving, copy: event.altKey, over: moving ? dropTarget(event) : null };
}
function onCelUp(event: PointerEvent): void {
  const d = drag.value;
  drag.value = null;
  if (!d?.moving) return;
  const over = dropTarget(event);
  if (!over) return;
  if (event.altKey) copyCel({ loop: d.loop, cel: d.cel }, over.loop, over.at);
  else if (over.loop === d.loop) {
    // Dropping after itself or on its own slot changes nothing.
    const to = over.at > d.cel ? over.at - 1 : over.at;
    moveCel(d.loop, d.cel, Math.min(to, (document.loops[d.loop]?.cels.length ?? 1) - 1));
  }
}

// ---- context menu --------------------------------------------------------

interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** The item turns the menu into the loop picker instead of closing it. */
  readonly picks?: boolean;
  readonly run: () => void;
}
/** `pick`: the menu is the loop picker for copying or moving its cel. */
const menu = shallowRef<{
  x: number;
  y: number;
  loop: number;
  cel: number | null;
  pick?: "copy" | "move";
} | null>(null);
const menuEl = useTemplateRef("menuEl");

function openMenu(x: number, y: number, l: number, c: number | null): void {
  if (c !== null) select(l, c);
  menu.value = { x, y, loop: l, cel: c };
  void nextTick(() => {
    const element = menuEl.value;
    if (!element) return;
    // Keep the whole menu on screen: it opens upward or leftward where it must.
    const box = element.getBoundingClientRect();
    const margin = 8;
    const fitX = Math.min(x, window.innerWidth - box.width - margin);
    const fitY = y + box.height + margin > window.innerHeight ? y - box.height : y;
    if (menu.value && (fitX !== x || fitY !== y))
      menu.value = { ...menu.value, x: Math.max(margin, fitX), y: Math.max(margin, fitY) };
    element.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  });
}
function closeMenu(): void {
  const open = menu.value;
  menu.value = null;
  if (open) focusCel(open.loop, open.cel ?? 0);
}

/** The menu's items are being swapped for the picker's (or back): focus stays in the menu. */
let switching = false;
function pickLoop(pick: "copy" | "move" | undefined): void {
  const open = menu.value;
  if (!open) return;
  switching = true;
  menu.value = { x: open.x, y: open.y, loop: open.loop, cel: open.cel, ...(pick ? { pick } : {}) };
  void nextTick(() => {
    switching = false;
    menuEl.value?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  });
}
function onMenuFocusOut(event: FocusEvent): void {
  if (switching || menuEl.value?.contains(event.relatedTarget as Node | null)) return;
  menu.value = null;
}

/** The loop picker: every loop (a move skips the cel's own), then Back. */
function loopPicker(l: number, c: number, pick: "copy" | "move"): MenuItem[][] {
  const loops = document.loops.flatMap((_, target) => {
    if (pick === "move" && target === l) return [];
    const facing = loopFacing(target, document.loops.length);
    const at = document.loops[target]!.cels.length;
    return [
      {
        label: `Loop ${target}${facing ? ` · ${facing}` : ""}${target === l ? " (this loop)" : ""}`,
        run: () =>
          pick === "copy" ? copyCel({ loop: l, cel: c }, target, at) : moveToLoop(l, c, target),
      },
    ];
  });
  return [loops, [{ label: "Back", picks: true, run: () => pickLoop(undefined) }]];
}

const menuItems = computed<MenuItem[][]>(() => {
  const open = menu.value;
  if (!open) return [];
  const l = open.loop;
  const entry = document.loops[l];
  if (!entry) return [];
  const count = entry.cels.length;
  if (open.pick && open.cel !== null) return loopPicker(l, open.cel, open.pick);
  const groups: MenuItem[][] = [];
  if (open.cel !== null) {
    const c = open.cel;
    groups.push([
      { label: "Duplicate cel", hint: "⌘D", run: () => duplicateCel(l, c) },
      { label: "Add blank cel after", hint: "+", run: () => addBlank(l, c + 1) },
      { label: "Copy to loop…", picks: true, run: () => pickLoop("copy") },
      {
        label: "Move to loop…",
        picks: true,
        disabled: count === 1 || document.loops.length === 1,
        run: () => pickLoop("move"),
      },
      { label: "Move cel left", hint: "⌥←", disabled: c === 0, run: () => moveCel(l, c, c - 1) },
      {
        label: "Move cel right",
        hint: "⌥→",
        disabled: c >= count - 1,
        run: () => moveCel(l, c, c + 1),
      },
      {
        label: "Flip cel horizontally",
        run: () => edit({ type: "flipCel", loop: l, cel: c, axis: "h" }, "Flip cel"),
      },
      {
        label: "Delete cel",
        hint: "Del",
        danger: true,
        disabled: count === 1,
        run: () => deleteCel(l, c),
      },
    ]);
  }
  const loopItems: MenuItem[] = [
    {
      label: "Add loop after",
      run: () => edit({ type: "addLoop", at: l + 1, from: "blank" }, "Add loop"),
    },
    {
      label: "Duplicate loop",
      run: () => edit({ type: "addLoop", at: l + 1, from: l }, "Duplicate loop"),
    },
    {
      label: "Add mirror of this loop",
      run: () =>
        edit({ type: "addLoop", at: document.loops.length, mirrorOf: l }, "Add mirror loop"),
    },
  ];
  if (aliasGroup(document, l).length > 1)
    loopItems.push({
      label: "Unlink mirror (make a separate copy)",
      run: () => edit({ type: "unlinkMirror", loop: l }, "Unlink mirror"),
    });
  for (const other of document.loops.keys()) {
    if (other === l || aliasGroup(document, l).includes(other)) continue;
    const mirrored = document.loops[other]!.cels.map(mirroredCel);
    const exact =
      entry.cels.length === mirrored.length &&
      entry.cels.every((one, index) => sameDisplay(one, mirrored[index]!));
    loopItems.push({
      label: exact ? `Link as mirror of loop ${other}` : `Replace with mirror of loop ${other}`,
      run: () => edit({ type: "linkMirror", loop: l, of: other, force: !exact }, "Link mirror"),
    });
  }
  loopItems.push({
    label: "Delete loop",
    danger: true,
    disabled: document.loops.length === 1,
    run: () => {
      edit({ type: "deleteLoop", loop: l }, "Delete loop");
      select(Math.max(0, Math.min(l, document.loops.length - 2)), 0, true);
    },
  });
  groups.push(loopItems);
  return groups;
});

function runItem(item: MenuItem): void {
  if (item.disabled) return;
  if (!item.picks) menu.value = null;
  item.run();
}
function onMenuKey(event: KeyboardEvent): void {
  const items = [
    ...(menuEl.value?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []),
  ];
  const at = items.indexOf(globalThis.document.activeElement as HTMLElement);
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeMenu();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  }
}
</script>

<template>
  <section
    ref="root"
    class="timeline"
    aria-labelledby="timeline-title"
    data-testid="sprite-timeline"
  >
    <header class="timeline__head">
      <h3 id="timeline-title">Loops × cels</h3>
      <span>
        Drag cels to reorder · Alt-drag copies · Right-click or Menu key: duplicate, copy or move to
        a loop, flip, delete, link
      </span>
    </header>
    <div class="timeline__rows" role="grid" aria-labelledby="timeline-title">
      <div
        v-for="row in loops"
        :key="row.index"
        role="row"
        class="timeline__row"
        :class="{ 'is-linked': row.alias !== null, 'is-current': row.index === loop }"
        :data-testid="`sprite-loop-${row.index}`"
        :data-alias="row.alias ?? undefined"
      >
        <div
          role="rowheader"
          class="timeline__loop"
          @contextmenu.prevent="openMenu($event.clientX, $event.clientY, row.index, null)"
        >
          <b>Loop {{ row.index }}</b>
          <span v-if="row.facing">{{ row.facing }}</span>
          <span
            v-if="row.alias !== null"
            class="timeline__chip"
            :data-testid="`sprite-loop-${row.index}-mirror`"
          >
            <UiIcon name="link" :size="12" />mirror of {{ row.alias }}
          </span>
          <button
            type="button"
            class="timeline__more"
            :aria-label="`Loop ${row.index} actions`"
            :data-testid="`sprite-loop-${row.index}-menu`"
            @click="
              (e) => {
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenu(box.left, box.bottom, row.index, null);
              }
            "
          >
            ⋯
          </button>
        </div>
        <div class="timeline__cels" role="gridcell">
          <template v-for="(entry, index) in row.cels" :key="index">
            <span
              class="timeline__drop"
              :class="{ 'is-over': drag?.over?.loop === row.index && drag.over.at === index }"
              :data-drop-loop="row.index"
              :data-drop-at="index"
            ></span>
            <button
              type="button"
              class="timeline__cel"
              :class="{ 'is-selected': row.index === loop && index === cel }"
              :aria-label="`Loop ${row.index}, cel ${index}`"
              :aria-pressed="row.index === loop && index === cel"
              :tabindex="row.index === loop && index === cel ? 0 : -1"
              :data-loop="row.index"
              :data-cel="index"
              :data-drop-loop="row.index"
              :data-drop-at="index"
              @focus="row.index !== loop || index !== cel ? select(row.index, index) : undefined"
              @keydown="onCelKey($event, row.index, index)"
              @pointerdown="onCelDown($event, row.index, index)"
              @pointermove="onCelMove"
              @pointerup="onCelUp"
              @pointercancel="drag = null"
              @contextmenu.prevent="openMenu($event.clientX, $event.clientY, row.index, index)"
            >
              <i>{{ index }}</i>
              <SpriteThumb :cel="entry" :width="36" :height="36" />
            </button>
          </template>
          <button
            type="button"
            class="timeline__add"
            :aria-label="`Add a blank cel to loop ${row.index}`"
            :disabled="frozen"
            :data-drop-loop="row.index"
            :data-drop-at="row.cels.length"
            :class="{
              'is-over': drag?.over?.loop === row.index && drag.over.at === row.cels.length,
            }"
            :data-testid="`sprite-add-cel-${row.index}`"
            @click="addBlank(row.index, row.cels.length)"
          >
            +
          </button>
        </div>
      </div>
    </div>
    <div
      v-if="menu"
      ref="menuEl"
      class="timeline__menu"
      role="menu"
      :aria-label="
        menu.pick
          ? `${menu.pick === 'copy' ? 'Copy' : 'Move'} loop ${menu.loop}, cel ${menu.cel} to loop`
          : menu.cel === null
            ? `Loop ${menu.loop}`
            : `Loop ${menu.loop}, cel ${menu.cel}`
      "
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      data-testid="sprite-context-menu"
      @keydown="onMenuKey"
      @focusout="onMenuFocusOut"
    >
      <template v-for="(group, g) in menuItems" :key="g">
        <hr v-if="g > 0" />
        <button
          v-for="item in group"
          :key="item.label"
          type="button"
          role="menuitem"
          :class="{ 'is-danger': item.danger }"
          :disabled="item.disabled || frozen"
          @click="runItem(item)"
        >
          <span>{{ item.label }}</span>
          <kbd v-if="item.hint">{{ item.hint }}</kbd>
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  border-top: 1px solid var(--hairline);
  background: var(--surface-1);
}
.timeline__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4) var(--space-2);
}
.timeline__head h3 {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.timeline__head span {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline__rows {
  overflow: auto;
  padding: 0 var(--space-3) var(--space-3);
}
.timeline__row {
  display: grid;
  grid-template-columns: 14rem minmax(0, 1fr);
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
}
.timeline__row.is-current {
  background: var(--surface-2);
}
.timeline__row.is-linked {
  background-image: repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-3) 6px 8px);
}
.timeline__loop {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
  white-space: nowrap;
}
.timeline__loop span {
  color: var(--ink-2);
}
.timeline__loop .timeline__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-pill);
  color: var(--action);
  font-size: var(--text-2xs);
}
.timeline__more {
  margin-left: auto;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: transparent;
  cursor: pointer;
}
.timeline__more:hover,
.timeline__more:focus-visible {
  color: var(--ink);
  background: var(--surface-3);
}
.timeline__cels {
  display: flex;
  align-items: center;
  overflow-x: auto;
}
.timeline__drop {
  align-self: stretch;
  width: var(--space-1);
  margin: 0 1px;
  border-radius: var(--radius-pill);
}
.timeline__drop.is-over {
  background: var(--action);
}
.timeline__cel,
.timeline__add {
  position: relative;
  display: grid;
  place-items: end center;
  flex: none;
  width: 42px;
  height: 42px;
  padding: 2px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: var(--surface-sunken);
  cursor: grab;
  touch-action: none;
}
.timeline__cel i {
  position: absolute;
  top: 1px;
  left: 3px;
  font: normal var(--text-2xs) / 1 var(--font-mono);
}
.timeline__cel.is-selected {
  border-color: var(--action);
  box-shadow: 0 0 0 1px var(--action);
}
.timeline__cel:focus-visible,
.timeline__add:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.timeline__add {
  place-items: center;
  margin-left: var(--space-2);
  border-style: dashed;
  background: transparent;
  cursor: pointer;
  font-size: var(--text-md);
}
.timeline__add.is-over {
  border-color: var(--action);
}
.timeline__menu {
  position: fixed;
  z-index: var(--z-popover);
  display: grid;
  min-width: 15rem;
  padding: var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  transform: translateY(var(--space-1));
}
.timeline__menu hr {
  width: 100%;
  margin: var(--space-1) 0;
  border: 0;
  border-top: 1px solid var(--hairline);
}
.timeline__menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: transparent;
  font: var(--text-xs) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.timeline__menu button:hover:not(:disabled),
.timeline__menu button:focus-visible {
  background: var(--surface-3);
  outline: 0;
}
.timeline__menu button:disabled {
  color: var(--ink-disabled);
  cursor: default;
}
.timeline__menu button.is-danger:not(:disabled) {
  color: var(--danger);
}
.timeline__menu kbd {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
</style>
