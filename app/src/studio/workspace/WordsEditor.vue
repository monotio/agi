<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { parseSentence } from "../../../../src/runtime/parser.ts";
import { buildWordsTok } from "../../../../src/logic/words.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";
import type { PlayerSentence } from "../../project/playerSentences.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import UiButton from "../../ui/UiButton.vue";
import UiExplain from "../../ui/UiExplain.vue";
import { wordGroups, nextWordGroup } from "./wordGroups.ts";
import { meaningUses, sentenceOutcomes, type WordRows } from "./wordsAnalysis.ts";
import { readWordSuggestions, wordsTaskPrompt, type WordsTask } from "./wordsAgent.ts";
const props = defineProps<{
  source: string;
  documents: Readonly<Record<string, ProjectContent>>;
  room: number;
  active: boolean;
  profile: AgiProfile;
}>();
const emit = defineEmits<{
  edit: [source: string];
  move: [move: { from: number; to: number; word?: string }];
  remove: [word: string];
  openLogic: [logic: number, line: number];
  response: [room: number, command: string];
  task: [task: WordsTask];
}>();
const engine = useEngineApi();
const editor = useWorkspaceEditor();
const entries = computed<WordRows>(() => {
  try {
    return JSON.parse(props.source) as WordRows;
  } catch {
    return [];
  }
});
const uses = computed(() => meaningUses(entries.value, props.documents, props.profile));
const empty = ref<number[]>([]);
const drafts = ref<Record<string, string>>({});
const find = ref("");
const sentence = ref("");
const error = ref("");
const ghosts = ref<Record<string, string[]>>({});
const predictions = ref<string[]>([]);
const predictionRows = computed(() =>
  predictions.value.map((command) => {
    const parsed = parseSentence(command, new Map(entries.value));
    const unknown = parsed.tokens.find((token) => token.status === "new")?.text;
    const outcomes = sentenceOutcomes(
      command,
      entries.value,
      props.documents,
      props.room,
      props.profile,
    );
    const answered = !unknown && outcomes.length > 0;
    const conditional = outcomes.some((outcome) => outcome.conditional);
    return {
      command,
      answered,
      description: unknown
        ? `“${unknown}” is a new word`
        : answered
          ? conditional
            ? "Answers when the game's state allows it"
            : `LOGIC ${outcomes[0]!.logic} answers`
          : VOCABULARY.noResponse.label,
    };
  }),
);
const pendingTask = ref<{ task: WordsTask; start: number; source: string; room: number }>();
const groups = computed(() => {
  const rows = wordGroups(entries.value).map((group) => {
    const head =
      uses.value[String(group.id)]
        ?.flatMap((use) => use.words)
        .find((word) => group.words.includes(word)) ?? group.words[0];
    return {
      ...group,
      words: head ? [head, ...group.words.filter((word) => word !== head)] : group.words,
    };
  });
  for (const id of [0, ...empty.value])
    if (!rows.some((row) => row.id === id)) rows.push({ id, words: [] });
  return rows.sort(
    (a, b) =>
      (uses.value[String(b.id)]?.length ?? 0) - (uses.value[String(a.id)]?.length ?? 0) ||
      a.id - b.id,
  );
});
const meanings = computed(() =>
  groups.value.filter(
    (group) =>
      ![0, 1, 9999].includes(group.id) &&
      (!find.value ||
        String(group.id).includes(find.value) ||
        group.words.some((word) => word.includes(find.value.toLowerCase()))),
  ),
);
const skipped = computed(() => groups.value.find((group) => group.id === 0)!);
const parsed = computed(() => parseSentence(sentence.value, new Map(entries.value)));
const outcomes = computed(() =>
  sentenceOutcomes(sentence.value, entries.value, props.documents, props.room, props.profile),
);
const tried = computed(() => engine.playerSentences.value);
const unknown = computed(
  () => parsed.value.tokens.find((token) => token.status === "new")?.text ?? "",
);
const moving = ref<{ from: number; word: string; to: number; merge: boolean }>();
const same = ref<{ word: string; id: number; entry?: PlayerSentence }>();
function label(id: number | undefined): string {
  return groups.value.find((group) => group.id === id)?.words[0] ?? String(id ?? "");
}
function write(next: WordRows): void {
  try {
    buildWordsTok(next.map(([word, id]) => ({ word, id })));
    error.value = "";
    emit("edit", JSON.stringify(next));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
function addWord(id: number, value?: string): void {
  const word = (value ?? drafts.value[String(id)] ?? "")
    .trim()
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (!word) return;
  if (entries.value.some(([entry]) => entry === word)) {
    error.value = `“${word}” already has a meaning. Choose Move to… to change it.`;
    return;
  }
  write([...entries.value, [word, id]]);
  drafts.value[String(id)] = "";
  ghosts.value[String(id)] = (ghosts.value[String(id)] ?? []).filter((ghost) => ghost !== word);
}
function wordKey(event: KeyboardEvent, id: number, words: readonly string[]): void {
  if (event.key === "Enter") {
    event.preventDefault();
    addWord(id);
  } else if (event.key === "Backspace" && !drafts.value[String(id)] && words.length) {
    event.preventDefault();
    emit("remove", words.at(-1)!);
  }
}
async function addMeaning(word?: string): Promise<void> {
  const id = nextWordGroup([...entries.value, ...empty.value.map((group) => ["", group] as const)]);
  empty.value.push(id);
  find.value = "";
  if (word) addWord(id, word);
  await nextTick();
  document.querySelector<HTMLInputElement>(`[data-word-group="${id}"] input`)?.focus();
}
function drop(event: DragEvent, to: number): void {
  const value = event.dataTransfer?.getData("application/x-agi-word");
  if (!value) return;
  try {
    const data = JSON.parse(value) as { from: number; word: string };
    if (data.from !== to) moving.value = { ...data, to, merge: true };
  } catch {
    /* Ignore unrelated drags. */
  }
}
function drag(event: DragEvent, from: number, word: string): void {
  event.dataTransfer?.setData("application/x-agi-word", JSON.stringify({ from, word }));
}
function move(): void {
  const value = moving.value;
  if (!value || value.from === value.to) return;
  emit("move", { from: value.from, to: value.to, ...(value.merge ? {} : { word: value.word }) });
  moving.value = undefined;
}
function closest(word: string): number {
  // Edit distance is a spelling hint; the builder chooses the meaning.
  function distance(a: string, b: string): number {
    let row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])));
      row = next;
    }
    return row[b.length]!;
  }
  return (
    [...entries.value]
      .filter(([, id]) => ![0, 1, 9999].includes(id))
      .sort(([a], [b]) => distance(word, a) - distance(word, b))[0]?.[1] ?? 0
  );
}
function sameAs(word: string, entry?: PlayerSentence): void {
  same.value = { word, id: closest(word), ...(entry ? { entry } : {}) };
}
function acceptSame(): void {
  if (!same.value) return;
  addWord(same.value.id, same.value.word);
  if (!error.value && same.value.entry) engine.resolvePlayerSentence(same.value.entry);
  if (!error.value) same.value = undefined;
}
function task(value: WordsTask): void {
  pendingTask.value = {
    task: value,
    start: editor.agentMessages.value.length,
    source: props.source,
    room: props.room,
  };
  emit("task", value);
}
watch(
  () => editor.agentMessages.value,
  (messages) => {
    const pending = pendingTask.value;
    if (!pending || pending.source !== props.source || pending.room !== props.room) return;
    const request = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        message.text.startsWith(wordsTaskPrompt(pending.task, props.documents).split("\n")[0]!),
    );
    if (request < 0) return;
    const reply = messages.slice(request + 1).findLast((message) => message.role === "assistant");
    if (!reply) return;
    const values = readWordSuggestions(reply.text, pending.task.kind);
    if (!values.length) {
      pendingTask.value = undefined;
      return;
    }
    if (pending.task.kind === "suggest")
      ghosts.value[String(pending.task.group)] = values.filter(
        (word) => !entries.value.some(([existing]) => existing === word),
      );
    else if (pending.task.kind === "predict") predictions.value = values;
    pendingTask.value = undefined;
  },
  { deep: true },
);
function typeInGame(): void {
  engine.sendInput(sentence.value);
}
function dismissGhosts(event: KeyboardEvent): void {
  if (!moving.value && !same.value && !Object.values(ghosts.value).some((words) => words.length))
    return;
  event.stopPropagation();
  ghosts.value = {};
  moving.value = undefined;
  same.value = undefined;
}
</script>
<template>
  <div class="words-editor" data-testid="workspace-words-editor" @keydown.esc="dismissGhosts">
    <header class="words-toolbar">
      <input
        v-model="find"
        :aria-label="VOCABULARY.findWord.label"
        :placeholder="VOCABULARY.findWord.label"
        :title="VOCABULARY.findWord.help"
      />
      <UiButton size="sm" @click="task({ kind: 'predict', room })">{{
        VOCABULARY.predictCommands.label
      }}</UiButton>
      <UiButton size="sm" @click="addMeaning()">{{ VOCABULARY.meaningButton.label }}</UiButton>
    </header>
    <p v-if="error" class="words-error" role="alert">{{ error }}</p>
    <form v-if="moving" class="words-choice" @submit.prevent="move" aria-label="Move to…">
      <strong>{{ VOCABULARY.moveWord.label }} {{ moving.word }}</strong>
      <select v-model.number="moving.to" aria-label="Destination meaning">
        <option
          v-for="group in groups.filter(
            (row) => row.id !== moving!.from && ![1, 9999].includes(row.id),
          )"
          :key="group.id"
          :value="group.id"
        >
          {{ label(group.id) }} · {{ group.id }}
        </option>
      </select>
      <label><input v-model="moving.merge" type="checkbox" />Merge the whole meaning</label>
      <p>LOGIC references keep the surviving meaning.</p>
      <UiButton type="submit" size="sm">{{ moving.merge ? "Merge" : "Move" }}</UiButton
      ><UiButton size="sm" variant="ghost" @click="moving = undefined">Cancel</UiButton>
    </form>
    <form v-if="same" class="words-choice" @submit.prevent="acceptSame" aria-label="Same as…">
      <strong>{{ same.word }} · {{ VOCABULARY.sameAs.label }}</strong>
      <select v-model.number="same.id" aria-label="Same meaning">
        <option
          v-for="group in groups.filter((row) => ![1, 9999].includes(row.id))"
          :key="group.id"
          :value="group.id"
        >
          {{ group.id === 0 ? VOCABULARY.skippedWords.label : label(group.id) }} · {{ group.id }}
        </option>
      </select>
      <UiButton size="sm" type="submit">Add word</UiButton
      ><UiButton size="sm" variant="ghost" @click="same = undefined">Cancel</UiButton>
    </form>
    <div class="words-body">
      <section :aria-label="VOCABULARY.trySentence.label">
        <div class="words-section">
          <h3>{{ VOCABULARY.trySentence.label }}</h3>
          <small>{{ VOCABULARY.sentenceParser.label }}</small>
        </div>
        <div class="sentence-tester">
          <div class="sentence-input">
            <span>&gt;</span
            ><input
              v-model="sentence"
              aria-label="A sentence a player might type"
              @keydown.enter.prevent="typeInGame"
            /><UiButton
              size="sm"
              :disabled="!sentence || !active"
              :title="
                sentence ? VOCABULARY.typeSentence.help : 'Type a sentence to try it in the game'
              "
              @click="typeInGame"
              >{{ VOCABULARY.typeSentence.label }}</UiButton
            >
          </div>
          <div class="sentence-parse" aria-live="polite" data-testid="sentence-parse">
            <span
              v-for="(token, index) in parsed.tokens"
              :key="index"
              class="sentence-token"
              :class="token.status"
              ><b>{{ token.text }}</b
              ><small>{{
                token.status === "known"
                  ? `= ${label(token.id)} · ${token.id}`
                  : token.status === "new"
                    ? VOCABULARY.newWord.label
                    : token.status === "skipped"
                      ? VOCABULARY.skippedWord.label
                      : VOCABULARY.unreadWord.label
              }}</small></span
            >
          </div>
          <div
            v-if="sentence"
            class="sentence-verdict"
            aria-live="polite"
            data-testid="sentence-outcome"
          >
            <template v-if="unknown">
              <p>
                The game stops reading at <b>“{{ unknown }}”</b>, a new word.
              </p>
              <div class="words-actions">
                <UiButton size="sm" @click="sameAs(unknown)"
                  >Add “{{ unknown }}” to a meaning…</UiButton
                ><UiButton size="sm" @click="addMeaning(unknown)"
                  >New meaning “{{ unknown }}”</UiButton
                ><UiButton size="sm" @click="addWord(0, unknown)">Skip it like “the”</UiButton>
              </div>
            </template>
            <template v-if="outcomes.length">
              <div v-for="(outcome, index) in outcomes" :key="index">
                <button class="words-link" @click="emit('openLogic', outcome.logic, outcome.line)">
                  LOGIC {{ outcome.logic }} · line {{ outcome.line }}
                </button>
                <p>
                  Answers<span v-if="outcome.message"> “{{ outcome.message }}”</span
                  ><span v-if="outcome.conditional"> when the game's state allows it</span>
                </p>
              </div>
            </template>
            <template v-else-if="!unknown"
              ><p>{{ VOCABULARY.noResponse.label }}</p>
              <UiButton size="sm" @click="emit('response', room, sentence)">{{
                VOCABULARY.addResponse.label
              }}</UiButton></template
            >
          </div>
        </div>
      </section>
      <section v-if="predictions.length" class="words-predictions" aria-label="Predicted commands">
        <div class="words-section">
          <h3>✦ Players will likely try in ROOM {{ room }}</h3>
          <UiButton size="sm" @click="predictions = []">Hide</UiButton>
        </div>
        <div v-for="prediction in predictionRows" :key="prediction.command" class="tried-row">
          <code>{{ prediction.command }}</code
          ><small>{{ prediction.answered ? "✓ " : "○ " }}{{ prediction.description }}</small>
          <UiButton
            v-if="!prediction.answered"
            size="sm"
            @click="emit('response', room, prediction.command)"
            >{{ VOCABULARY.addResponse.label }}</UiButton
          >
        </div>
        <UiButton
          size="sm"
          :disabled="predictionRows.every((row) => row.answered)"
          title="Choose commands with a response gap to review"
          @click="
            task({
              kind: 'review',
              room,
              commands: predictionRows.filter((row) => !row.answered).map((row) => row.command),
            })
          "
          >{{ VOCABULARY.reviewCommands.label }}</UiButton
        >
        <p class="words-note">{{ VOCABULARY.predictCommands.help }}</p>
      </section>
      <section :aria-label="VOCABULARY.playersTried.label">
        <div class="words-section">
          <h3>{{ VOCABULARY.playersTried.label }}</h3>
          <small>{{ VOCABULARY.playtests.label }}</small>
        </div>
        <div class="tried-list">
          <p v-if="!tried.length" class="words-note">
            Play and type freely. Sentences the game misses show up here.
          </p>
          <div
            v-for="entry in tried"
            :key="`${entry.room}:${entry.text}`"
            class="tried-row"
            data-testid="player-sentence"
          >
            <div>
              <code>{{ entry.text }}</code
              ><small> ×{{ entry.count }} · ROOM {{ entry.room }}</small>
              <p class="words-note">
                {{
                  entry.unknown ? `“${entry.unknown}” is a new word` : VOCABULARY.noResponse.label
                }}
              </p>
            </div>
            <div class="words-actions">
              <UiButton v-if="entry.unknown" size="sm" @click="sameAs(entry.unknown, entry)"
                >{{ VOCABULARY.sameAs.label }} {{ label(closest(entry.unknown)) }}</UiButton
              ><UiButton size="sm" @click="emit('response', entry.room, entry.text)">{{
                VOCABULARY.addResponse.label
              }}</UiButton
              ><button
                class="chip-remove"
                :aria-label="`Dismiss ${entry.text}`"
                @click="engine.resolvePlayerSentence(entry)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      </section>
      <section :aria-label="VOCABULARY.meanings.label">
        <div class="words-section">
          <h3>{{ VOCABULARY.meanings.label }}</h3>
          <small>{{ meanings.length }}</small
          ><UiExplain
            question
            term="words-meanings"
            :name="VOCABULARY.meanings.label"
            :says="VOCABULARY.meanings.help"
            technical="Stored as a word group in WORDS.TOK."
          /><small class="words-order">{{ VOCABULARY.orderWords.label }}</small>
        </div>
        <div
          v-for="group in meanings"
          :key="group.id"
          class="meaning-row"
          :data-word-group="group.id"
          @dragover.prevent
          @drop.prevent="drop($event, group.id)"
        >
          <div class="meaning-chips">
            <span class="word-id">{{ group.id }}</span>
            <span
              v-for="(word, index) in group.words"
              :key="word"
              class="word-chip"
              :class="{ head: index === 0 }"
              draggable="true"
              @dragstart="drag($event, group.id, word)"
              ><span>{{ word }}</span
              ><button
                class="chip-move"
                :aria-label="`${VOCABULARY.moveWord.label} ${word}`"
                @click="
                  moving = {
                    from: group.id,
                    word,
                    to:
                      groups.find((row) => row.id !== group.id && ![1, 9999].includes(row.id))
                        ?.id ?? 0,
                    merge: false,
                  }
                "
              >
                ↗</button
              ><button
                class="chip-remove"
                :aria-label="`Remove ${word}`"
                @click="emit('remove', word)"
              >
                ×
              </button></span
            >
            <button
              v-for="word in ghosts[String(group.id)] ?? []"
              :key="word"
              class="word-chip word-suggestion"
              @click="addWord(group.id, word)"
            >
              {{ word }}
            </button>
            <input
              v-model="drafts[String(group.id)]"
              class="add-word"
              :aria-label="`${VOCABULARY.addWord.label}: ${group.words.join(', ') || VOCABULARY.wordGroup.label}`"
              :placeholder="VOCABULARY.addWord.label"
              @keydown="wordKey($event, group.id, group.words)"
            />
            <button
              class="words-link suggest"
              @click="task({ kind: 'suggest', group: group.id, words: group.words })"
            >
              {{ VOCABULARY.suggestWords.label }}
            </button>
          </div>
          <div class="meaning-uses">
            <template v-if="uses[String(group.id)]?.length"
              ><small
                >{{ uses[String(group.id)]!.length }}
                {{ uses[String(group.id)]!.length === 1 ? "use" : "uses" }}</small
              ><button
                v-for="use in uses[String(group.id)]"
                :key="`${use.logic}:${use.line}`"
                class="words-link"
                :title="`LOGIC ${use.logic} · line ${use.line}`"
                @click="emit('openLogic', use.logic, use.line)"
              >
                LOGIC {{ use.logic }} · {{ use.line }}
              </button></template
            ><template v-else
              ><small>{{ VOCABULARY.readyResponse.label }}</small
              ><UiButton size="sm" @click="emit('response', room, group.words[0] ?? '')">{{
                VOCABULARY.addResponse.label
              }}</UiButton></template
            >
          </div>
        </div>
      </section>
      <section
        class="skipped-words"
        aria-label="Skipped words"
        data-word-group="0"
        @dragover.prevent
        @drop.prevent="drop($event, 0)"
      >
        <div class="meaning-chips">
          <span class="word-id">0</span><strong>{{ VOCABULARY.skippedWords.label }}</strong
          ><span
            v-for="word in skipped.words"
            :key="word"
            class="word-chip"
            draggable="true"
            @dragstart="drag($event, 0, word)"
            >{{ word
            }}<button
              class="chip-move"
              :aria-label="`${VOCABULARY.moveWord.label} ${word}`"
              @click="moving = { from: 0, word, to: meanings[0]?.id ?? 2, merge: false }"
            >
              ↗</button
            ><button
              class="chip-remove"
              :aria-label="`Remove ${word}`"
              @click="emit('remove', word)"
            >
              ×
            </button></span
          ><input
            v-model="drafts['0']"
            class="add-word"
            :aria-label="`${VOCABULARY.addWord.label}: Skipped`"
            :placeholder="VOCABULARY.addWord.label"
            @keydown="wordKey($event, 0, skipped.words)"
          />
        </div>
        <p class="words-note">{{ VOCABULARY.skippedWords.help }}</p>
      </section>
      <footer class="reserved-words">
        <span v-for="id in [1, 9999]" :key="id"
          ><span class="word-id">{{ id }}</span
          >{{ id === 1 ? "anyword" : "rest of line"
          }}<UiExplain
            question
            :term="`reserved-word-${id}`"
            :name="id === 1 ? VOCABULARY.anyWord.label : VOCABULARY.restOfLine.label"
            :says="id === 1 ? VOCABULARY.anyWord.help : VOCABULARY.restOfLine.help"
            :technical="`Reserved WORDS.TOK group ${id}.`"
        /></span>
      </footer>
    </div>
  </div>
</template>
<style scoped>
.words-editor {
  height: 100%;
  overflow: auto;
  color: var(--ink-2);
}
.words-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.words-toolbar input {
  flex: 1;
  min-width: 100px;
}
.words-body {
  display: grid;
  gap: var(--space-6);
  padding: var(--space-5);
}
.words-section {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
h3 {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ink);
}
small,
.words-note {
  font-size: var(--text-xs);
  color: var(--ink-3);
}
p {
  margin: var(--space-2) 0;
  font-size: var(--text-sm);
}
.words-section small:last-child,
.words-order {
  margin-left: auto;
}
.sentence-tester {
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface-1);
}
.sentence-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.sentence-input input {
  flex: 1;
  min-width: 100px;
  border: 0;
  background: transparent;
}
.sentence-parse {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3);
}
.sentence-parse:empty {
  padding: 0;
}
.sentence-token {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  font-size: var(--text-sm);
}
.sentence-token.known {
  border-color: var(--action);
}
.sentence-token.new {
  border-color: var(--warn);
}
.sentence-token.new small {
  color: var(--warn);
}
.sentence-token.skipped,
.sentence-token.unread {
  opacity: 0.65;
}
.sentence-verdict {
  border-top: 1px solid var(--hairline);
  padding: var(--space-3);
}
.meaning-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  margin-bottom: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-1);
}
.meaning-row:hover {
  border-color: var(--hairline-strong);
}
.meaning-chips,
.meaning-uses,
.words-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.meaning-uses {
  padding-left: var(--space-8);
}
.word-id {
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  min-width: var(--space-6);
}
.word-chip {
  font-family: var(--font-mono);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  font-size: var(--text-sm);
  background: var(--surface-3);
  color: var(--ink-2);
}
.word-chip.head {
  color: var(--action);
  background: var(--action-soft);
  border-color: var(--action-line);
  font-weight: 600;
}
.word-suggestion {
  border-style: dashed;
  color: var(--action);
  cursor: pointer;
}
.chip-remove,
.chip-move {
  border: 0;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  padding: 0 var(--space-1);
  font: inherit;
}
.word-chip .chip-remove,
.word-chip .chip-move {
  opacity: 0;
}
.word-chip:hover .chip-remove,
.word-chip:hover .chip-move,
.word-chip:focus-within .chip-remove,
.word-chip:focus-within .chip-move {
  opacity: 1;
}
@media (hover: none) {
  .word-chip .chip-remove,
  .word-chip .chip-move {
    opacity: 1;
  }
}
.words-link {
  border: 0;
  background: transparent;
  color: var(--action);
  padding: 0;
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  text-align: left;
}
.words-link:hover {
  text-decoration: underline;
}
input,
select {
  box-sizing: border-box;
  padding: var(--space-2);
  color: var(--ink);
  background: var(--surface-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  font: inherit;
  font-size: var(--text-sm);
}
input.add-word {
  width: 110px;
  border-style: dashed;
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
}
.suggest {
  margin-left: auto;
}
.tried-list,
.words-predictions {
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
}
.tried-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--hairline);
}
.tried-row:last-child {
  border: 0;
}
code {
  font: var(--text-sm) var(--font-mono);
  color: var(--ink);
}
.words-choice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-2);
  border-bottom: 1px solid var(--hairline);
}
.words-choice label {
  font-size: var(--text-xs);
}
.words-choice p {
  width: 100%;
}
.words-error {
  color: var(--warn);
  padding: var(--space-3);
}
.reserved-words {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.reserved-words > span {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
