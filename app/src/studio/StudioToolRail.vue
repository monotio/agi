<script setup lang="ts">
import UiIconButton from "../ui/UiIconButton.vue";
import type { IconName } from "../ui/icons.ts";
import StudioCurrentValues from "./StudioCurrentValues.vue";
import type { LensUnlocks } from "./studioLocks.ts";
import type { CurrentValues, StudioTool } from "./studioTools.ts";
import type { StudioLens } from "./studioView.ts";

/**
 * The tool rail on the canvas's left edge: select and point, the drawing
 * tools, the pipette, the actor probe and the hand, each with its key, and
 * under them the values new content draws with.
 */
const {
  frozen,
  probeActive,
  probeAvailable,
  lens,
  unlocks,
  values,
  cursorY = undefined,
} = defineProps<{
  /** Drawing is blocked: the drawing tools are disabled. */
  frozen: boolean;
  probeActive: boolean;
  /** The game has VIEWs for the probe to stand. */
  probeAvailable: boolean;
  lens: StudioLens;
  unlocks: LensUnlocks;
  values: CurrentValues;
  cursorY?: number | undefined;
}>();
const emit = defineEmits<{ probe: []; values: [patch: Partial<CurrentValues>] }>();
const tool = defineModel<StudioTool>("tool", { required: true });
interface RailTool {
  readonly id: StudioTool;
  readonly icon: IconName;
  readonly label: string;
  readonly key: string;
  readonly draws?: boolean;
}
const GROUPS: readonly (readonly RailTool[])[] = [
  [
    { id: "select", icon: "select", label: "Select and move", key: "V" },
    { id: "point", icon: "spline", label: "Points only", key: "A" },
  ],
  [
    { id: "line", icon: "line", label: "Line", key: "L", draws: true },
    { id: "rect", icon: "rect", label: "Rectangle", key: "R", draws: true },
    { id: "polygon", icon: "polygon", label: "Polygon", key: "P", draws: true },
    { id: "fill", icon: "fill", label: "Fill", key: "F", draws: true },
    { id: "brush", icon: "brush", label: "Brush", key: "B", draws: true },
    { id: "pipette", icon: "pipette", label: "Pick colour and priority", key: "I" },
  ],
];
</script>

<template>
  <aside class="tool-rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
    <template v-for="(group, g) in GROUPS" :key="g">
      <span v-if="g > 0" class="tool-rail__sep" aria-hidden="true"></span>
      <div v-for="entry in group" :key="entry.id" class="tool-rail__tool">
        <UiIconButton
          :icon="entry.icon"
          :label="entry.label"
          :shortcut="entry.key"
          :pressed="tool === entry.id"
          :disabled="entry.draws && frozen"
          :data-tool="entry.id"
          @click="tool = entry.id"
        />
        <kbd aria-hidden="true">{{ entry.key }}</kbd>
      </div>
    </template>
    <span class="tool-rail__sep" aria-hidden="true"></span>
    <div class="tool-rail__tool">
      <UiIconButton
        icon="actor"
        :label="probeAvailable ? 'Actor probe' : 'Actor probe (this game has no VIEWs)'"
        shortcut="G"
        :pressed="probeActive"
        :disabled="!probeAvailable"
        data-testid="studio-probe-toggle"
        @click="emit('probe')"
      />
      <kbd aria-hidden="true">G</kbd>
    </div>
    <div class="tool-rail__tool">
      <UiIconButton
        icon="hand"
        label="Pan (or hold Space)"
        shortcut="H"
        :pressed="tool === 'hand'"
        data-tool="hand"
        @click="tool = 'hand'"
      />
      <kbd aria-hidden="true">H</kbd>
    </div>
    <span class="tool-rail__spacer"></span>
    <StudioCurrentValues
      :lens
      :unlocks
      :values
      :cursor-y="cursorY"
      @values="emit('values', $event)"
    />
  </aside>
</template>

<style scoped>
.tool-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-2) 0;
  border-right: 1px solid var(--hairline);
  background: var(--surface-1);
}
.tool-rail__tool {
  position: relative;
}
.tool-rail__tool kbd {
  position: absolute;
  right: 1px;
  bottom: 0;
  color: var(--ink-3);
  font: var(--text-2xs) / 1 var(--font-mono);
  pointer-events: none;
}
.tool-rail__sep {
  width: var(--space-6);
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--hairline);
}
.tool-rail__spacer {
  flex: 1;
}
</style>
