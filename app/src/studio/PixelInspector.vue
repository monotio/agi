<script setup lang="ts">
import { computed } from "vue";
import UiChip from "../ui/UiChip.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiExplain from "../ui/UiExplain.vue";
import { priorityForY } from "../../../src/runtime/priority.ts";
import type { FillExplanation } from "../../../src/studio/pictureQuery.ts";
import { explain } from "./studioTerms.ts";
import { priorityMeaning } from "./studioView.ts";
import type { PixelInfo, PlanePixel, SceneRow } from "./useStudioDocument.ts";

interface InspectorCommand {
  /** Timeline index. */
  entry: number;
  line: number;
  text: string;
}

/**
 * The inspector: what the selection needs, and the rest under Details. On
 * top, the selection's name (editable while `rename` is given) and one line,
 * "Visual · locked"; then the Studio's editor (`editor` slot: the item's kind,
 * lock, art and depth, and its actions), then Ask (`assist`). Details, closed
 * by default and remembered per viewer, holds the expert read-outs: the
 * selection's steps (click one to scrub there), the pixel under the pointer
 * or clicked, with the step that last wrote each plane, whether a fill at the
 * marker reaches it, the colours and depth values an item draws, and what
 * the Studio adds (`more` slot: an item's points, several items' depth). A view's own panel (the room tools', the ghost's,
 * a lesson's card) goes in the `lead` slot above it all, and `foot` says in
 * one line how the selection moves.
 */
const {
  row,
  commands,
  colours,
  priorities,
  pixel,
  pinned,
  fill,
  editing = false,
  more = "",
  playhead,
  labelOf,
  rename = undefined,
  parts = undefined,
  foot = "",
} = defineProps<{
  row: SceneRow | undefined;
  commands: readonly InspectorCommand[];
  colours: readonly number[];
  priorities: readonly number[];
  pixel: PixelInfo | null;
  pinned: boolean;
  fill: FillExplanation | undefined;
  /** The editor slot holds the item's own art and depth pickers: the read-only lists step aside. */
  editing?: boolean;
  /** What the `more` slot adds to Details, for its closed row ("Points"). */
  more?: string;
  playhead: number;
  labelOf: (id: string) => string;
  /** Renames the selected item; false keeps the name it had. Absent, the name is plain text. */
  rename?: ((label: string) => boolean) | undefined;
  /** The selected item was grouped from this many parts. */
  parts?: number | undefined;
  /** One line at the inspector's foot: how the selection moves. */
  foot?: string;
}>();
const emit = defineEmits<{ seek: [count: number]; select: [id: string] }>();

const KIND_NAMES: Record<SceneRow["kind"], string> = {
  art: "Visual",
  depth: "Priority",
  walk: "Walls",
  mixed: "Mixed",
  loose: "Loose steps",
};
/** The header's one line: what the selection is. Its steps wait under Details. */
const summary = computed(() => {
  if (!row) return "";
  const head = parts !== undefined ? `Group · ${parts} parts` : KIND_NAMES[row.kind];
  return `${head}${row.locked ? " · locked" : ""}`;
});
/** What Details holds, for its closed row: the pixel shows once the pointer is on the picture. */
const detailsHint = computed(() =>
  [
    row && "Steps",
    "Pixel",
    fill && "Fill",
    row && !editing && colours.length > 0 && "Colours",
    more,
    "Picture",
  ]
    .filter(Boolean)
    .join(" · "),
);
const planes = computed(() =>
  pixel
    ? ([
        ["Visual", pixel.visual, String(pixel.visual.value)],
        [
          "Priority",
          pixel.priority,
          `${pixel.priority.value} · ${priorityMeaning(pixel.priority.value)}`,
        ],
      ] as const)
    : [],
);
/** The step that last wrote a plane: its number and verb, then the rest on expand. */
function writer(plane: PlanePixel): { head: string; rest: string } {
  if (plane.entry === null) return { head: "from the start", rest: "" };
  const [verb = "", ...rest] = (plane.text ?? "").trim().split(/\s+/);
  return { head: `step ${plane.entry + 1} ${verb}`.trim(), rest: rest.join(" ") };
}
function commitName(event: Event): void {
  const input = event.target as HTMLInputElement;
  const label = input.value.trim();
  if (!row || label === row.label || !label || !rename?.(label)) input.value = row?.label ?? "";
}
</script>

<template>
  <aside class="inspector" aria-label="Inspector" data-testid="studio-inspector">
    <slot name="lead" />
    <header v-if="row" class="inspector__title" data-testid="inspector-title">
      <input
        v-if="row && rename"
        class="inspector__name"
        :value="row.label"
        aria-label="Name"
        title="Click to rename"
        data-testid="item-label"
        @change="commitName"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <h2 v-else>{{ row.label }}</h2>
      <p class="inspector__sub" data-testid="inspector-subtitle">{{ summary }}</p>
    </header>
    <slot name="editor" />
    <slot name="assist" />

    <UiDisclosure
      id="room-inspector"
      storage-key="monotio_agi.studioDetails"
      :hint="detailsHint"
      test-id="inspector-details"
    >
      <section v-if="row" class="inspector__sec" data-role="steps">
        <h3>Steps <em>Preview a step</em></h3>
        <ol class="inspector__cmds" data-testid="inspector-commands">
          <li v-for="cmd in commands" :key="cmd.entry">
            <button
              type="button"
              :aria-current="cmd.entry + 1 === playhead ? 'step' : undefined"
              @click="emit('seek', cmd.entry + 1)"
            >
              <span class="inspector__n">#{{ cmd.entry + 1 }}</span>
              <span class="inspector__text">{{ cmd.text }}</span>
            </button>
          </li>
        </ol>
      </section>

      <section v-if="pixel" class="inspector__sec" data-role="pixel">
        <h3>
          Pixel {{ pixel.x }},{{ pixel.y }}
          <em class="inspector__with"
            >{{ pinned ? "clicked" : "pointer" }} · band {{ priorityForY(pixel.y) }}
            <UiExplain v-bind="explain('bands')"
          /></em>
        </h3>
        <dl class="inspector__planes">
          <template v-for="[name, plane, value] in planes" :key="name">
            <dt>{{ name }}</dt>
            <dd>
              <span class="inspector__value">
                <i
                  class="inspector__swatch"
                  :style="{ background: `var(--agi-${plane.value})` }"
                  aria-hidden="true"
                ></i>
                {{ value }}
              </span>
              <details v-if="writer(plane).rest" class="inspector__writer" data-role="writer">
                <summary>{{ writer(plane).head }}</summary>
                <span>{{ writer(plane).rest }}</span>
              </details>
              <span v-else class="inspector__writer" data-role="writer">{{
                writer(plane).head
              }}</span>
              <button
                v-if="plane.entry !== null"
                type="button"
                class="inspector__link"
                title="Scrub to this step"
                @click="emit('seek', plane.entry + 1)"
              >
                Show step {{ plane.entry + 1 }}
              </button>
              <button
                v-if="plane.rowId"
                type="button"
                class="inspector__link"
                @click="emit('select', plane.rowId)"
              >
                {{ labelOf(plane.rowId) }}
              </button>
            </dd>
          </template>
        </dl>
      </section>

      <section v-if="fill" class="inspector__sec" data-role="why-not-filled">
        <h3>
          Fill
          <UiChip :tone="fill.fillable ? 'ok' : 'warn'" dot>
            {{ fill.fillable ? "reaches here" : "stops here" }}
          </UiChip>
        </h3>
        <p class="inspector__note">{{ fill.message }}</p>
      </section>

      <template v-if="row && !editing">
        <section v-if="colours.length > 0" class="inspector__sec" data-role="colours">
          <h3>Colours</h3>
          <div class="inspector__pal">
            <i
              v-for="c in 16"
              :key="c"
              :class="{ 'is-on': colours.includes(c - 1) }"
              :style="{ background: `var(--agi-${c - 1})` }"
              :title="`Colour ${c - 1}${colours.includes(c - 1) ? ', drawn' : ''}`"
            ></i>
          </div>
        </section>
        <section v-if="priorities.length > 0" class="inspector__sec" data-role="depths">
          <h3 class="inspector__with">Depth values <UiExplain v-bind="explain('walk-lines')" /></h3>
          <div class="inspector__prio" role="list" aria-label="Depth values">
            <i
              v-for="v in 16"
              :key="v"
              role="listitem"
              :class="{ 'is-control': v - 1 < 4, 'is-on': priorities.includes(v - 1) }"
              :aria-label="`${v - 1}${priorities.includes(v - 1) ? ', drawn' : ''}`"
              >{{ v - 1 }}</i
            >
          </div>
        </section>
      </template>
      <slot name="more" />
    </UiDisclosure>
    <span class="inspector__grow" aria-hidden="true"></span>
    <p v-if="foot" class="inspector__foot" data-testid="inspector-foot">{{ foot }}</p>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  /* Sideways, only an explainer's invisible target could reach past the edge. */
  overflow: hidden auto;
  border-left: 1px solid var(--hairline);
  background: var(--surface-1);
}
.inspector__title {
  padding: var(--space-5) var(--space-5) var(--space-4);
  border-bottom: 1px solid var(--hairline);
}
.inspector__title h2,
.inspector__name {
  margin: 0 0 var(--space-1);
  color: var(--ink);
  font: var(--weight-bold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
/* The name reads as the heading and edits in place: a field only on hover and focus. */
.inspector__name {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h-sm);
  margin-left: calc(-1 * var(--space-2));
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  text-overflow: ellipsis;
}
.inspector__name:hover {
  border-color: var(--hairline-strong);
}
.inspector__name:focus-visible {
  border-color: var(--action-line);
  outline: 2px solid var(--focus);
  outline-offset: 1px;
  background: var(--surface-sunken);
}
.inspector__sub {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.inspector__with {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.inspector__grow {
  flex: 1 0 0;
}
.inspector__foot {
  margin: 0;
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--hairline);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.inspector__sec {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.inspector__sec h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.inspector__sec h3 em {
  font-style: normal;
  font-weight: var(--weight-medium);
  letter-spacing: 0;
  text-transform: none;
}
.inspector__planes {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  margin: 0;
  font-size: var(--text-xs);
}
.inspector__planes dt {
  color: var(--ink-3);
}
.inspector__planes dd {
  display: grid;
  gap: var(--space-0);
  margin: 0;
  min-width: 0;
}
.inspector__value {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink);
  font-family: var(--font-mono);
}
.inspector__swatch {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.inspector__writer {
  color: var(--ink-2);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.inspector__writer summary {
  cursor: pointer;
}
.inspector__link {
  justify-self: start;
  padding: 0;
  border: 0;
  color: var(--action);
  background: none;
  font: inherit;
  cursor: pointer;
}
.inspector__link:hover {
  text-decoration: underline;
}
.inspector__note {
  margin: var(--space-3) 0 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  color: var(--ink-2);
  background: var(--surface-2);
  font-size: var(--text-xs);
}
.inspector__prio {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: var(--space-0);
}
.inspector__prio i {
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: var(--surface-3);
  font: var(--text-2xs) var(--font-mono);
  line-height: 22px;
  font-style: normal;
  text-align: center;
}
.inspector__prio i.is-control {
  color: var(--ink-2);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.inspector__prio i.is-on {
  color: var(--action-ink);
  background: var(--action);
  font-weight: var(--weight-bold);
}
.inspector__pal {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--space-1);
}
.inspector__pal i {
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
  opacity: 0.35;
}
.inspector__pal i.is-on {
  opacity: 1;
  box-shadow:
    0 0 0 2px var(--surface-1),
    0 0 0 3px var(--action);
}
.inspector__cmds {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.inspector__cmds button {
  display: flex;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: none;
  font: var(--text-2xs) / var(--leading) var(--font-mono);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.inspector__cmds button:hover {
  color: var(--ink);
  background: var(--surface-2);
}
.inspector__cmds button[aria-current="step"] {
  color: var(--ink);
  background: var(--action-soft);
}
.inspector__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.inspector__n {
  flex: none;
  min-width: 3.2em;
  color: var(--ink-3);
}
</style>
