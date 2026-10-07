<script setup lang="ts">
import { computed } from "vue";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { workspaceGameStateInfos } from "../../shell/workspaceNames.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { EngineStateReport } from "../../../../src/runtime/engine.ts";

/** The Game state tab: the flags and variables the game named, with live values. */
const props = defineProps<{
  active?: boolean;
  snapshot: ProjectSnapshot | undefined;
  state: EngineStateReport | null;
  profile: AgiProfile;
}>();
const groups = computed(() => {
  if (!props.snapshot) return { game: [], builtin: [] };
  try {
    return workspaceGameStateInfos(props.snapshot, props.profile.id);
  } catch {
    return { game: [], builtin: [] };
  }
});
const creatorRows = computed(() => groups.value.game);
const builtinRows = computed(() => groups.value.builtin);
function value(row: { kind: string; num: number }): string {
  if (!props.state) return "—";
  return String(
    row.kind === "flag" ? (props.state.flags[row.num] ? 1 : 0) : (props.state.vars[row.num] ?? 0),
  );
}
</script>

<template>
  <div class="workspace-state" data-testid="workspace-state">
    <table v-if="creatorRows.length">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slot</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in creatorRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>
            <span class="workspace-state__kind">{{
              row.kind === "flag" ? "Flag" : "Variable"
            }}</span>
            {{ row.kind === "flag" ? "f" : "v" }}{{ row.num }}
          </td>
          <td class="workspace-state__value">{{ value(row) }}</td>
        </tr>
      </tbody>
    </table>
    <details v-if="builtinRows.length" class="workspace-state__builtin" data-testid="state-builtin">
      <summary>Built-in</summary>
      <table>
        <tbody>
          <tr v-for="row in builtinRows" :key="row.name">
            <td>
              <span>{{ row.name }}</span>
              <small class="workspace-state__meaning">{{ row.meaning }}</small>
              <small v-if="row.usage" class="workspace-state__usage">Used: {{ row.usage }}</small>
            </td>
            <td>
              <span class="workspace-state__kind">{{
                row.kind === "flag" ? "Flag" : "Variable"
              }}</span>
              {{ row.kind === "flag" ? "f" : "v" }}{{ row.num }}
            </td>
            <td class="workspace-state__value">{{ value(row) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
    <p v-if="!creatorRows.length" class="workspace-state__empty">
      No named flags or variables yet. Add one with + next to Game state in Parts.
    </p>
    <p v-if="!state" class="workspace-state__note">Values show while the game runs.</p>
  </div>
</template>

<style scoped>
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
