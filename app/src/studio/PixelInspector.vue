<script setup lang="ts">
import { computed } from "vue";
import UiChip from "../ui/UiChip.vue";
import UiIcon from "../ui/UiIcon.vue";
import { priorityForY } from "../../../src/runtime/priority.ts";
import type { FillExplanation } from "../../../src/studio/pictureQuery.ts";
import { priorityMeaning } from "./studioView.ts";
import type { PixelInfo, PlanePixel, SceneRow } from "./useStudioDocument.ts";

export interface InspectorCommand {
  /** Timeline index. */
  entry: number;
  line: number;
  text: string;
}

/**
 * The inspector: the selected item (its commands, colours and priorities)
 * and the hovered or clicked pixel on both planes, with the command that
 * last wrote it. With a fill command at the playhead, a clicked pixel also
 * explains whether that fill reaches it.
 */
const { row, commands, colours, priorities, pixel, pinned, fill, trusted, playhead, labelOf } =
  defineProps<{
    row: SceneRow | undefined;
    commands: readonly InspectorCommand[];
    colours: readonly number[];
    priorities: readonly number[];
    pixel: PixelInfo | null;
    pinned: boolean;
    fill: FillExplanation | undefined;
    trusted: boolean;
    playhead: number;
    labelOf: (id: string) => string;
  }>();
const emit = defineEmits<{ seek: [count: number]; select: [id: string] }>();

const KIND_NAMES: Record<SceneRow["kind"], string> = {
  art: "Art item",
  depth: "Depth item",
  walk: "Walk item",
  mixed: "Mixed item",
  loose: "Lines outside any item",
};
const summary = computed(() => {
  if (!row) return "";
  const n = row.entries.length;
  return `${KIND_NAMES[row.kind]} · ${n} ${n === 1 ? "command" : "commands"}${row.locked ? " · locked" : ""}`;
});
const planes = computed(() =>
  pixel
    ? ([
        ["Visual", pixel.visual, `colour ${pixel.visual.value}`],
        [
          "Priority",
          pixel.priority,
          `${pixel.priority.value} · ${priorityMeaning(pixel.priority.value)}`,
        ],
      ] as const)
    : [],
);
const writer = (plane: PlanePixel): string =>
  plane.entry === null ? "not drawn (initial value)" : `#${plane.entry + 1} ${plane.text ?? ""}`;
</script>

<template>
  <aside class="inspector" aria-label="Inspector">
    <header class="inspector__title">
      <h2>{{ row ? row.label : "Nothing selected" }}</h2>
      <p>{{ row ? summary : "Click an item in the Scene list or a pixel on the canvas." }}</p>
    </header>

    <section v-if="pixel" class="inspector__sec" data-role="pixel">
      <h3>
        Pixel {{ pixel.x }},{{ pixel.y }}
        <em>{{ pinned ? "clicked" : "under the pointer" }} · band {{ priorityForY(pixel.y) }}</em>
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
            <span class="inspector__writer">{{ writer(plane) }}</span>
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
        Fill reach
        <UiChip :tone="fill.fillable ? 'ok' : 'warn'" dot>
          {{ fill.fillable ? "reaches this cell" : "stops here" }}
        </UiChip>
      </h3>
      <p class="inspector__note">{{ fill.message }}</p>
    </section>

    <template v-if="row">
      <section v-if="priorities.length > 0" class="inspector__sec">
        <h3>Priority <em>values this item draws</em></h3>
        <div class="inspector__prio" role="list" aria-label="Priority values">
          <i
            v-for="v in 16"
            :key="v"
            role="listitem"
            :class="{ 'is-control': v - 1 < 4, 'is-on': priorities.includes(v - 1) }"
            :aria-label="`${v - 1}${priorities.includes(v - 1) ? ', drawn' : ''}`"
            >{{ v - 1 }}</i
          >
        </div>
        <p class="inspector__note">
          Priorities 0–3 are control lines (barrier, conditional, signal, water). The Walk lens
          labels them.
        </p>
      </section>
      <section v-if="colours.length > 0" class="inspector__sec">
        <h3>Colours <em>visual</em></h3>
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
      <section class="inspector__sec inspector__sec--grow">
        <h3>Commands <em>click to scrub there</em></h3>
        <ol class="inspector__cmds">
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
    </template>

    <section class="inspector__sec inspector__evidence">
      <UiChip v-if="trusted" tone="ok" dot>Authored source · compiles exactly</UiChip>
      <UiChip v-else dot>Disassembled from the stored bytes</UiChip>
      <UiChip><UiIcon name="lock" :size="12" />Read-only</UiChip>
    </section>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  border-left: 1px solid var(--hairline);
  background: var(--surface-1);
}
.inspector__title {
  padding: var(--space-5) var(--space-5) var(--space-4);
  border-bottom: 1px solid var(--hairline);
}
.inspector__title h2 {
  margin: 0 0 var(--space-1);
  color: var(--ink);
  font-size: var(--text-md);
}
.inspector__title p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.inspector__sec {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.inspector__sec--grow {
  flex: 1 0 auto;
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
  overflow: hidden;
  color: var(--ink-2);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
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
.inspector__evidence {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  border-bottom: 0;
}
</style>
