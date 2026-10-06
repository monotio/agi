<script setup lang="ts">
import { computed } from "vue";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { EngineStateReport } from "../../../../src/runtime/engine.ts";

/** The Game state tab: the flags and variables the game named, with live values. */
const props = defineProps<{
  active?: boolean;
  bindings: string;
  state: EngineStateReport | null;
  profile: AgiProfile;
}>();

interface StateRow {
  readonly name: string;
  readonly kind: "flag" | "variable";
  readonly num: number;
  readonly label: string;
}

const rows = computed<StateRow[]>(() => {
  try {
    return Object.entries(readBindingsDocument(props.bindings))
      .filter(([, binding]) => binding.kind === "flag" || binding.kind === "variable")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, binding]) => ({
        name,
        kind: binding.kind as "flag" | "variable",
        num: binding.num,
        label: `${binding.kind === "flag" ? "f" : "v"}${binding.num}`,
      }));
  } catch {
    return [];
  }
});
function value(row: StateRow): string {
  if (!props.state) return "—";
  return String(
    row.kind === "flag" ? (props.state.flags[row.num] ? 1 : 0) : (props.state.vars[row.num] ?? 0),
  );
}
</script>

<template>
  <div class="workspace-state" data-testid="workspace-state">
    <table v-if="rows.length">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slot</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>
            <span class="workspace-state__kind">{{
              row.kind === "flag" ? "Flag" : "Variable"
            }}</span>
            {{ row.label }}
          </td>
          <td class="workspace-state__value">{{ value(row) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="workspace-state__empty">
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
</style>
