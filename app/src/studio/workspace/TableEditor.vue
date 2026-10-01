<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { computed, nextTick, ref } from "vue";
import UiExplain from "../../ui/UiExplain.vue";
import { wordGroups, nextWordGroup } from "./wordGroups.ts";
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
const emptyGroups = ref<number[]>([]);
const drafts = ref<Record<string, string>>({});
const groups = computed(() => {
  const result = wordGroups(rows.value);
  for (const id of emptyGroups.value)
    if (!result.some((group) => group.id === id)) result.push({ id, words: [] });
  return result;
});
function groupTerm(id: number) {
  return id === 0
    ? VOCABULARY.ignoredWords
    : id === 1
      ? VOCABULARY.anyWord
      : id === 9999
        ? VOCABULARY.restOfLine
        : VOCABULARY.wordGroup;
}
function addWord(id: number): void {
  const word = (drafts.value[String(id)] ?? "")
    .trim()
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (!word || rows.value.some(([existing]) => existing === word)) return;
  write([...rows.value.map((row) => [...row] as [string, number]), [word, id]]);
  drafts.value[String(id)] = "";
}
function removeWord(id: number, word: string): void {
  if (!emptyGroups.value.includes(id)) emptyGroups.value.push(id);
  write(
    rows.value
      .filter(([existing, group]) => existing !== word || group !== id)
      .map((row) => [...row] as [string, number]),
  );
}
function onWordKey(event: KeyboardEvent, id: number, words: readonly string[]): void {
  if (event.key === "Enter") {
    event.preventDefault();
    addWord(id);
  } else if (event.key === "Backspace" && !(drafts.value[String(id)] ?? "") && words.length) {
    event.preventDefault();
    removeWord(id, words.at(-1)!);
  }
}
async function addMeaning(): Promise<void> {
  const id = nextWordGroup([
    ...rows.value,
    ...emptyGroups.value.map((group) => ["", group] as const),
  ]);
  emptyGroups.value.push(id);
  await nextTick();
  document.querySelector<HTMLInputElement>(`[data-word-group="${id}"] input`)?.focus();
}
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
    [VOCABULARY.objectColumn.label, 255],
  ]);
}
</script>
<template>
  <div class="workspace-table" data-testid="workspace-table-editor">
    <p>
      {{ kind === "words" ? VOCABULARY.words.help : VOCABULARY.objects.help }}
    </p>
    <div v-if="kind === 'words'" class="word-groups">
      <div
        v-for="(group, index) in groups"
        :key="group.id"
        class="word-group"
        :data-word-group="group.id"
      >
        <div class="word-group__words">
          <span
            v-if="group.id === 0 || group.id === 1 || group.id === 9999"
            class="word-group__label"
            >{{ groupTerm(group.id).label }}</span
          >
          <span v-for="word in group.words" :key="word" class="word-chip">
            {{ word
            }}<button
              type="button"
              :aria-label="`Remove ${word}`"
              @click="removeWord(group.id, word)"
            >
              ×
            </button>
          </span>
          <input
            v-model="drafts[String(group.id)]"
            :aria-label="`${VOCABULARY.addWord.label}: ${group.words.join(', ') || VOCABULARY.wordGroup.label}`"
            :placeholder="VOCABULARY.addWord.label"
            @keydown="onWordKey($event, group.id, group.words)"
          />
        </div>
        <UiExplain
          question
          :term="`word-meaning-${index}`"
          :name="groupTerm(group.id).label"
          :says="
            group.id === 0 || group.id === 1 || group.id === 9999
              ? groupTerm(group.id).help
              : VOCABULARY.wordGroup.help
          "
          :technical="`WORDS.TOK group ${group.id}.`"
        />
      </div>
      <UiButton size="sm" @click="addMeaning">{{ VOCABULARY.addGroup.label }}</UiButton>
    </div>
    <table v-else>
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
              :aria-label="`${VOCABULARY.objectColumn.label} ${index}`"
              :value="row[0]"
              @change="update(index, 0, ($event.target as HTMLInputElement).value)"
            />
          </td>
          <td>
            <input
              type="number"
              :aria-label="`${VOCABULARY.roomColumn.label} ${index}`"
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
    <UiButton v-if="kind === 'inventory'" size="sm" @click="add">+ Add</UiButton>
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
.word-groups {
  display: grid;
  gap: var(--space-3);
}
.word-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.word-group__words {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.word-group__label {
  width: 100%;
  font-size: var(--text-xs);
  color: var(--ink-3);
}
.word-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  font-size: var(--text-sm);
  background: var(--surface-2);
}
.word-chip button {
  border: 0;
  color: var(--ink-3);
  background: transparent;
  cursor: pointer;
  font-size: var(--text-md);
}
.word-group input {
  width: 140px;
  flex: 1 1 140px;
  max-width: 220px;
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
