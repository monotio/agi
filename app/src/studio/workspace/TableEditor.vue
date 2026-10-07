<script setup lang="ts">
import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "../../shell/useProjectLabels.ts";
import UiIcon from "../../ui/UiIcon.vue";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
import ItemRoomPicker from "./ItemRoomPicker.vue";
const props = defineProps<{ kind: "inventory"; source: string; readOnly?: boolean }>();
const emit = defineEmits<{ edit: [source: string] }>();
const labels = useProjectLabels();
const rows = computed<readonly (readonly [string, number])[]>(() => {
  try {
    const value = JSON.parse(props.source) as unknown;
    return (value as { name: string; startingRoom: number }[]).map((item) => [
      item.name,
      item.startingRoom,
    ]);
  } catch {
    return [];
  }
});
function update(index: number, column: number, value: string): void {
  const next = rows.value.map((row) => [...row] as [string, number]);
  const row = next[index];
  if (!row) return;
  if (column === 0) row[0] = value;
  else row[1] = Number(value);
  write(next);
}
function write(next: [string, number][]): void {
  emit("edit", JSON.stringify(next.map(([name, startingRoom]) => ({ name, startingRoom }))));
}
function add(): void {
  write([
    ...rows.value.map((row) => [...row] as [string, number]),
    [VOCABULARY.objectColumn.label, 255],
  ]);
}
</script>
<template>
  <div class="workspace-table" data-testid="workspace-table-editor">
    <table>
      <thead>
        <tr>
          <th>{{ VOCABULARY.objectColumn.label }}</th>
          <th>{{ VOCABULARY.roomColumn.label }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="index">
          <td>
            <input
              :readonly="readOnly"
              :aria-label="numberedLabel('inventory', index, { ...labels, name: row[0] }, 'option')"
              :value="row[0]"
              @change="update(index, 0, ($event.target as HTMLInputElement).value)"
            />
            <small>{{ numberedLabel("inventory", index) }}</small>
          </td>
          <td>
            <span class="table-room-label">{{ VOCABULARY.roomColumn.label }}</span>
            <ItemRoomPicker
              :disabled="readOnly"
              :context="labels"
              :label="`Starting room for ${numberedLabel('inventory', index, { ...labels, name: row[0] })}`"
              :value="row[1]"
              @change="update(index, 1, String($event))"
            />
          </td>
          <td>
            <UiButton
              :disabled="readOnly"
              :title="
                readOnly ? 'Editing is paused. Download your unsaved edits, then reload.' : ''
              "
              size="sm"
              :aria-label="`Remove ${row[0]}`"
              @click="
                write(rows.filter((_, i) => i !== index).map((r) => [...r] as [string, number]))
              "
              ><UiIcon name="x" :size="16"
            /></UiButton>
          </td>
        </tr>
      </tbody>
    </table>
    <UiButton
      :disabled="readOnly"
      :title="readOnly ? 'Editing is paused. Download your unsaved edits, then reload.' : ''"
      v-if="kind === 'inventory'"
      size="sm"
      @click="add"
      >+ Add</UiButton
    >
  </div>
</template>
<style scoped>
.workspace-table {
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  padding: var(--space-5);
  color: var(--ink-2);
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: var(--space-4);
}
th {
  text-align: left;
  font-size: var(--text-xs);
  padding: var(--space-2);
  color: var(--ink-3);
}
td {
  padding: var(--space-2);
  border-top: 1px solid var(--hairline);
}
input {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2);
  color: var(--ink);
  background: var(--surface-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
}
.table-room-label {
  display: none;
}
@media (max-width: 600px) {
  thead {
    display: none;
  }
  tbody,
  tr {
    display: block;
  }
  tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    border-top: 1px solid var(--hairline);
    padding-block: var(--space-2);
  }
  td {
    border-top: 0;
    min-width: 0;
  }
  td:first-child {
    grid-column: 1 / -1;
  }
  td:last-child {
    align-self: end;
  }
  .table-room-label {
    display: block;
    font-size: var(--text-xs);
    color: var(--ink-3);
    margin-bottom: var(--space-2);
  }
}
</style>
