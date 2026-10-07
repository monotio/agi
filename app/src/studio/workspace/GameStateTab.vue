<script setup lang="ts">
import { computed, nextTick, onWatcherCleanup, shallowRef, useTemplateRef, watch } from "vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import BindingDetails from "../../shell/BindingDetails.vue";
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { numberedLabel, numberedSlot } from "../../../../src/logic/numberedLabels.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { workspaceReferenceInfo, workspaceGameStateInfos } from "../../shell/workspaceNames.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { EngineStateReport } from "../../../../src/runtime/engine.ts";

/** The Game state tab: the flags and variables the game named, with live values. */
const props = defineProps<{
  active?: boolean;
  snapshot: ProjectSnapshot | undefined;
  state: EngineStateReport | null;
  profile: AgiProfile;
}>();
const workspace = useWorkspaceEditor();
const engine = useEngineApi();
const liveState = shallowRef(props.state);
watch(
  () => props.state,
  (state) => {
    liveState.value = state;
  },
);
watch(
  () => props.active,
  (active) => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onWatcherCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
    async function refresh(): Promise<void> {
      const state = await engine.readEngineState().catch(() => null);
      if (cancelled) return;
      liveState.value = state;
      // Schedule after the reply, so slow reads never overlap.
      timer = setTimeout(() => void refresh(), 250);
    }
    void refresh();
  },
  { immediate: true },
);
const root = useTemplateRef("root");
const builtin = useTemplateRef("builtin");
const selectedInfo = computed(() => {
  const request = workspace.stateLocation.value;
  if (!request || !props.snapshot) return undefined;
  const row = [...groups.value.game, ...groups.value.builtin].find(
    (row) => row.kind === request.kind && row.num === request.num && row.name === request.name,
  ) ??
    [...groups.value.game, ...groups.value.builtin].find(
      (row) => row.kind === request.kind && row.num === request.num,
    ) ?? { ...request, name: request.name || numberedSlot(request.kind, request.num), uses: [] };
  return workspaceReferenceInfo(props.snapshot, props.profile.id, row);
});
function selected(row: BindingInfo): boolean {
  return (
    selectedInfo.value?.kind === row.kind &&
    selectedInfo.value.num === row.num &&
    selectedInfo.value.name === row.name
  );
}
const groups = computed(() => {
  if (!props.snapshot) return { game: [], builtin: [] };
  try {
    return workspaceGameStateInfos(props.snapshot, props.profile.id);
  } catch {
    return { game: [], builtin: [] };
  }
});
const creatorRows = computed(() => {
  const rows = groups.value.game;
  const request = workspace.stateLocation.value;
  if (
    request &&
    ![...rows, ...groups.value.builtin].some(
      (row) => row.kind === request.kind && row.num === request.num,
    )
  )
    return [
      ...rows,
      {
        name: request.name || numberedSlot(request.kind, request.num),
        kind: request.kind,
        num: request.num,
        uses: [],
      },
    ];
  return rows;
});
const builtinRows = computed(() => groups.value.builtin);
watch(
  () => [props.active, workspace.stateLocation.value, creatorRows.value, builtinRows.value],
  async () => {
    if (!props.active || !selectedInfo.value) return;
    await nextTick();
    if (builtinRows.value.some(selected) && builtin.value) builtin.value.open = true;
    const entry = root.value?.querySelector<HTMLElement>('[aria-current="true"]');
    entry?.scrollIntoView({ block: "start" });
    entry?.focus({ preventScroll: true });
  },
  { immediate: true },
);
function value(row: { kind: string; num: number }): string {
  const state = liveState.value;
  if (!state) return "—";
  return String(row.kind === "flag" ? (state.flags[row.num] ? 1 : 0) : (state.vars[row.num] ?? 0));
}
</script>

<template>
  <div ref="root" class="workspace-state" data-testid="workspace-state">
    <p class="sr-only" role="status" aria-live="polite">
      {{
        selectedInfo
          ? `${numberedLabel(selectedInfo.kind, selectedInfo.num, { name: selectedInfo.name })} selected`
          : ""
      }}
    </p>
    <table v-if="creatorRows.length">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slot</th>
          <th>Value</th>
          <th><span class="workspace-state__kind">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in creatorRows" :key="row.name">
          <tr
            :data-testid="`state-${row.kind}-${row.num}`"
            tabindex="-1"
            :aria-current="selected(row) ? 'true' : undefined"
            :aria-label="`${numberedLabel(row.kind, row.num, { name: row.name })} · ${numberedSlot(row.kind, row.num)} · ${value(row)}`"
            :class="{ 'workspace-state__selected': selected(row) }"
          >
            <td>
              <button
                type="button"
                class="workspace-state__name"
                @click="workspace.findReferences(row)"
              >
                {{ numberedLabel(row.kind, row.num, { name: row.name }) }}
              </button>
            </td>
            <td>
              {{ numberedSlot(row.kind, row.num) }}
            </td>
            <td class="workspace-state__value">{{ value(row) }}</td>
            <td>
              <ActionMenu :label="`Actions for ${row.name}`" icon-only icon="ellipsis" size="sm">
                <button type="button" role="menuitem" @click="workspace.findReferences(row)">
                  Find references
                </button>
              </ActionMenu>
            </td>
          </tr>
          <tr v-if="selected(row)" class="workspace-state__references">
            <td colspan="4" :data-testid="`state-uses-${row.kind}-${row.num}`">
              <BindingDetails
                :info="selectedInfo!"
                @close="workspace.stateLocation.value = undefined"
                @renamed="workspace.findReferences($event)"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <details
      ref="builtin"
      v-if="builtinRows.length"
      class="workspace-state__builtin"
      data-testid="state-builtin"
    >
      <summary>Built-in</summary>
      <table>
        <tbody>
          <template v-for="row in builtinRows" :key="row.name">
            <tr
              :data-testid="`state-${row.kind}-${row.num}`"
              tabindex="-1"
              :aria-current="selected(row) ? 'true' : undefined"
              :aria-label="`${numberedLabel(row.kind, row.num, { name: row.name })} · ${numberedSlot(row.kind, row.num)} · ${value(row)}`"
              :class="{ 'workspace-state__selected': selected(row) }"
            >
              <td>
                <button
                  type="button"
                  class="workspace-state__name"
                  @click="workspace.findReferences(row)"
                >
                  {{ numberedLabel(row.kind, row.num, { name: row.name }) }}
                </button>
                <small class="workspace-state__meaning">{{ row.meaning }}</small>
                <small v-if="row.usage" class="workspace-state__usage">Used: {{ row.usage }}</small>
              </td>
              <td>
                {{ numberedSlot(row.kind, row.num) }}
              </td>
              <td class="workspace-state__value">{{ value(row) }}</td>
              <td>
                <ActionMenu :label="`Actions for ${row.name}`" icon-only icon="ellipsis" size="sm">
                  <button type="button" role="menuitem" @click="workspace.findReferences(row)">
                    Find references
                  </button>
                </ActionMenu>
              </td>
            </tr>
            <tr v-if="selected(row)" class="workspace-state__references">
              <td colspan="4" :data-testid="`state-uses-${row.kind}-${row.num}`">
                <BindingDetails
                  :info="selectedInfo!"
                  @close="workspace.stateLocation.value = undefined"
                  @renamed="workspace.findReferences($event)"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </details>
    <p v-if="!creatorRows.length" class="workspace-state__empty">
      Add a flag or variable with + beside Game state.
    </p>
    <p v-if="!liveState" class="workspace-state__note">Values show while the game runs.</p>
  </div>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.workspace-state__selected {
  background: var(--surface-2);
  outline: 2px solid var(--action);
  outline-offset: -2px;
}
.workspace-state__name {
  color: var(--ink);
  font: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: var(--space-1) 0;
}
.workspace-state__references td {
  padding: var(--space-2) 0;
}
.workspace-state__references :deep(.binding-details) {
  max-height: none;
}

.workspace-state {
  overflow: auto;
  padding: var(--space-4) var(--space-5);
  font-size: var(--text-sm);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  text-align: left;
  font: var(--weight-semibold) var(--text-xs) / var(--leading) var(--font-sans);
  color: var(--ink-3);
  letter-spacing: var(--tracking-caps);
}
td,
th {
  padding: var(--space-1) var(--space-3) var(--space-1) 0;
  border-bottom: 1px solid var(--hairline);
}
.workspace-state__meaning,
.workspace-state__usage {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.workspace-state__kind {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.workspace-state__value {
  font-family: var(--font-mono);
}
.workspace-state__empty,
.workspace-state__note {
  color: var(--ink-3);
}
.workspace-state__builtin {
  margin-top: var(--space-4);
}
.workspace-state__builtin > summary {
  cursor: pointer;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  margin-bottom: var(--space-2);
}
</style>
