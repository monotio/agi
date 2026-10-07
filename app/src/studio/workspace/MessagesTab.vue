<script setup lang="ts">
import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "../../shell/useProjectLabels.ts";
import { computed } from "vue";
import { parseLogicResource } from "../../../../src/logic/resource.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { openContainer } from "../../../../src/container/container.ts";

/** The Messages tab: every message string the game's LOGICs carry. */
const props = defineProps<{
  container: ReturnType<typeof openContainer> | undefined;
  keys: readonly string[];
  profile: AgiProfile;
}>();
const labels = useProjectLabels();

const rows = computed(() =>
  props.keys
    .filter((key) => key.startsWith("logic:"))
    .flatMap((key) => {
      const logic = Number(key.slice(6));
      const payload = props.container?.getResource("logic", logic);
      if (!payload) return [];
      try {
        return parseLogicResource(payload).messages.flatMap((text, index) =>
          text === null ? [] : [{ logic, slot: index + 1, text }],
        );
      } catch {
        return [];
      }
    }),
);
</script>

<template>
  <div class="workspace-messages" data-testid="workspace-messages">
    <table v-if="rows.length">
      <thead>
        <tr>
          <th>Logic</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="`${row.logic}:${row.slot}`">
          <td class="workspace-messages__logic">
            {{ numberedLabel("logic", row.logic, labels, "row") }} ·
            {{ numberedLabel("message", row.slot, { ...labels, logic: row.logic }, "option") }}
          </td>
          <td>{{ row.text }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="workspace-messages__empty">No messages in the game yet.</p>
  </div>
</template>

<style scoped>
.workspace-messages {
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
.workspace-messages__logic {
  color: var(--ink-3);
  white-space: nowrap;
}
.workspace-messages__empty {
  color: var(--ink-3);
}
</style>
