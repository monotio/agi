<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{ kind: "words" | "inventory"; source: string }>();
const emit = defineEmits<{ edit: [source: string] }>();
const rows = computed<readonly (readonly [string, number])[]>(() => {
  try {
    const value = JSON.parse(props.source) as unknown;
    if (props.kind === "words") return value as [string, number][];
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
  if (props.kind === "words") emit("edit", JSON.stringify(next));
  else {
    emit("edit", JSON.stringify(next.map(([name, startingRoom]) => ({ name, startingRoom }))));
  }
}
function add(): void {
  write([
    ...rows.value.map((row) => [...row] as [string, number]),
    [
      props.kind === "words" ? "word" : "Object",
      props.kind === "words" ? Math.max(1, ...rows.value.map((row) => row[1])) + 1 : 255,
    ],
  ]);
}
</script>
<template>
  <div class="workspace-table" data-testid="workspace-table-editor">
    <p>
      {{ kind === "words" ? VOCABULARY.words.help : VOCABULARY.objects.help }}
    </p>
    <table>
      <thead>
        <tr>
          <th>{{ kind === "words" ? "Word" : "OBJECT" }}</th>
          <th>{{ kind === "words" ? "Group" : "Room" }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="index">
          <td>
            <input
              :aria-label="`${kind === 'words' ? 'Word' : 'OBJECT'} ${index}`"
              :value="row[0]"
              @change="update(index, 0, ($event.target as HTMLInputElement).value)"
            />
          </td>
          <td>
            <input
              type="number"
              :aria-label="`${kind === 'words' ? 'Group' : 'Room'} ${index}`"
              :value="row[1]"
              @change="update(index, 1, ($event.target as HTMLInputElement).value)"
            />
          </td>
          <td>
            <UiButton
              size="sm"
              :aria-label="`Remove ${row[0]}`"
              @click="
                write(rows.filter((_, i) => i !== index).map((r) => [...r] as [string, number]))
              "
              >×</UiButton
            >
          </td>
        </tr>
      </tbody>
    </table>
    <UiButton size="sm" @click="add">+ Add</UiButton>
  </div>
</template>
<style scoped>
.workspace-table {
  overflow: auto;
  padding: var(--space-5);
  color: var(--ink-2);
}
p {
  margin: 0 0 var(--space-5);
  font-size: var(--text-sm);
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
</style>
