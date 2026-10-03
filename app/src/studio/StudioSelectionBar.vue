<script setup lang="ts">
import { computed, useId } from "vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { IconName } from "../ui/icons.ts";
import UiExplain from "../ui/UiExplain.vue";
import StudioValuePicker from "./StudioValuePicker.vue";
import { explain } from "./studioTerms.ts";
import { keyLabel } from "../ui/keyLabel.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The selection's actions, docked in the options bar above the canvas while
 * the Select tool has a selection: its name (or "N items"), then
 * Duplicate, for one item its depth (a picker that opens below it; several
 * items take theirs under the inspector's Details), Delete,
 * Group (for several) or Ungroup (for a group) and Ask, which opens Ask in
 * the inspector. Each applies to the whole selection as one
 * step. Nothing floats over the picture; short of room (`fold`) the actions
 * first show as icons (their names as tooltips), then fold into More, and
 * at 4 the name gives way (the inspector still shows it).
 */
const {
  label,
  several = false,
  priority,
  priorityLocked,
  depthValuesLocked,
  edit,
  askable = false,
  grouped = false,
  fold = 0,
} = defineProps<{
  /** The selection's name, or "N items". */
  label: string;
  /** Two items or more are selected. */
  several?: boolean;
  /** The one depth (priority) value the selection draws; null for none, undefined for several. */
  priority: number | null | undefined;
  /** Why depth is locked now, or null. */
  priorityLocked: string | null;
  depthValuesLocked: boolean;
  edit: StudioEditing;
  /** The game's AI can be asked here (not in the Studio harness). */
  askable?: boolean;
  /** The one selected item is a group: it can be ungrouped. */
  grouped?: boolean;
  fold?: number;
}>();
const emit = defineEmits<{ ask: []; combine: []; ungroup: [] }>();
const open = defineModel<boolean>("open", { required: true });
const pickerId = useId();
const NO_ASK = "Choose an AI model in Settings to enable Agent.";

interface Action {
  readonly id: string;
  readonly text: string;
  readonly icon: IconName;
  readonly run: () => void;
  readonly shortcut?: string;
  readonly disabled?: boolean;
}
/** Duplicate and Delete, then Group (several) or Ungroup (a group) and Ask: the actions beside Depth. */
const actions = computed<{ before: Action[]; after: Action[] }>(() => ({
  before: [
    {
      id: "duplicate",
      text: "Duplicate",
      icon: "copy",
      shortcut: keyLabel("Mod+D"),
      run: () => void edit.duplicate(),
    },
  ],
  after: [
    { id: "delete", text: "Delete", icon: "trash", shortcut: "Del", run: () => void edit.remove() },
    ...(several
      ? [
          {
            id: "combine",
            text: "Group",
            icon: "layers",
            shortcut: keyLabel("Mod+G"),
            run: () => emit("combine"),
          } as const,
        ]
      : grouped
        ? [
            {
              id: "ungroup",
              text: "Ungroup",
              icon: "unlink",
              shortcut: keyLabel("Mod+Shift+G"),
              run: () => emit("ungroup"),
            } as const,
          ]
        : []),
    {
      id: "ask",
      text: "Agent",
      icon: "sparkles",
      shortcut: "/",
      disabled: !askable,
      run: () => emit("ask"),
    },
  ],
}));
const iconTitle = (action: Action): string =>
  action.disabled && action.id === "ask"
    ? NO_ASK
    : action.id === "ask"
      ? "Tell the agent about the selection"
      : action.text;

function pick(value: number | null): void {
  if (edit.setColour("priority", value)) open.value = false;
}
</script>

<template>
  <div
    class="selection-bar"
    role="toolbar"
    aria-label="Selection"
    data-testid="studio-selection-bar"
    @keydown.esc="open && ((open = false), $event.stopPropagation())"
  >
    <b v-if="fold < 4" class="selection-bar__name" :title="label" data-testid="selection-name">{{
      label
    }}</b>
    <template v-if="fold < 2">
      <template v-for="action in actions.before" :key="action.id">
        <UiButton
          v-if="fold < 1"
          variant="ghost"
          size="sm"
          :icon="action.icon"
          :data-testid="`selection-${action.id}`"
          @click="action.run"
          >{{ action.text }}</UiButton
        >
        <UiIconButton
          v-else
          size="sm"
          :icon="action.icon"
          :label="iconTitle(action)"
          :shortcut="action.shortcut"
          :data-testid="`selection-${action.id}`"
          @click="action.run"
        />
      </template>
    </template>
    <span v-if="!several" class="selection-bar__priority">
      <UiButton
        variant="ghost"
        size="sm"
        trailing-icon="chevron-down"
        :aria-expanded="open"
        :aria-controls="pickerId"
        :title="
          priorityLocked ?? `Set the depth ${several ? 'these items draw' : 'this item draws'}`
        "
        data-testid="selection-priority"
        @click="open = !open"
      >
        Depth {{ priority === undefined ? "mixed" : priority === null ? "off" : priority }}
      </UiButton>
      <div v-if="open" :id="pickerId" class="selection-bar__picker" data-testid="selection-picker">
        <StudioValuePicker
          plane="priority"
          label="Depth value"
          :value="priority"
          :disabled="priorityLocked !== null"
          :allowed="(v) => !depthValuesLocked || v < 4"
          @pick="pick"
        />
        <p v-if="priorityLocked" class="selection-bar__note">{{ priorityLocked }}</p>
      </div>
    </span>
    <template v-if="fold < 2">
      <template v-for="action in actions.after" :key="action.id">
        <span
          v-if="fold < 1"
          class="selection-bar__wrap"
          :title="action.disabled ? NO_ASK : undefined"
        >
          <UiButton
            variant="ghost"
            size="sm"
            :icon="action.icon"
            :shortcut="
              action.id === 'combine' || action.id === 'ungroup' ? action.shortcut : undefined
            "
            :disabled="action.disabled"
            :title="
              action.disabled
                ? NO_ASK
                : action.shortcut
                  ? `${action.text} (${action.shortcut})`
                  : action.text
            "
            :data-testid="`selection-${action.id}`"
            @click="action.run"
            >{{ action.text }}</UiButton
          >
          <UiExplain
            v-if="action.id === 'combine' || action.id === 'ungroup'"
            v-bind="explain(action.id === 'combine' ? 'group' : 'ungroup')"
          />
        </span>
        <UiIconButton
          v-else
          size="sm"
          :icon="action.icon"
          :label="iconTitle(action)"
          :shortcut="action.shortcut"
          :disabled="action.disabled"
          :title="
            action.disabled || !action.shortcut
              ? iconTitle(action)
              : `${iconTitle(action)} (${action.shortcut})`
          "
          :data-testid="`selection-${action.id}`"
          @click="action.run"
        />
      </template>
    </template>
    <ActionMenu v-else label="More" test-id="selection-more">
      <button
        v-for="action in [...actions.before, ...actions.after]"
        :key="action.id"
        type="button"
        role="menuitem"
        :disabled="action.disabled"
        :title="action.disabled ? NO_ASK : undefined"
        @click="action.run"
      >
        {{ action.id === "ask" ? "Tell the agent about the selection" : action.text }}
      </button>
    </ActionMenu>
  </div>
</template>

<style scoped>
.selection-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  white-space: nowrap;
}
/* The name gives way before any action: its full text is its tooltip. */
.selection-bar__name {
  flex: 0 1 auto;
  min-width: 3rem;
  max-width: 16rem;
  margin-right: var(--space-2);
  overflow: hidden;
  color: var(--ink);
  font-weight: var(--weight-bold);
  text-overflow: ellipsis;
}
.selection-bar__priority,
.selection-bar__wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.selection-bar__picker {
  position: absolute;
  z-index: var(--z-popover);
  top: calc(100% + var(--space-2));
  left: 0;
  width: 280px;
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
  white-space: normal;
}
.selection-bar__note {
  margin: var(--space-2) 0 0;
  color: var(--warn);
  font-size: var(--text-2xs);
}
</style>
