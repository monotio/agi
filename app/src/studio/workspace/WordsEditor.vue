<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { VOCABULARY, WORDS_EDITOR_COPY } from "../../../../src/vocabulary.ts";
import { parseSentence } from "../../../../src/runtime/parser.ts";
import { buildWordsTok } from "../../../../src/logic/words.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";
import type { PlayerSentence } from "../../project/playerSentences.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useAiSettings } from "../../settings/useAiSettings.ts";
import UiButton from "../../ui/UiButton.vue";
import UiExplain from "../../ui/UiExplain.vue";
import { wordGroups, nextWordGroup } from "./wordGroups.ts";
import {
  meaningUses,
  formatMeaningUses,
  sentenceOutcomes,
  type WordRows,
} from "./wordsAnalysis.ts";
import { runWordsTask, type WordsTask } from "./wordsAgent.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { prepareWorkspaceAction, type WorkspaceAction } from "./workspaceGuided.ts";
import SentenceFields from "./SentenceFields.vue";
const props = defineProps<{
  readOnly?: boolean;
  source: string;
  documents: Readonly<Record<string, ProjectContent>>;
  room: number;
  active: boolean;
  profile: AgiProfile;
  snapshot: ProjectSnapshot;
}>();
const emit = defineEmits<{
  edit: [source: string];
  move: [move: { from: number; to: number; word?: string }];
  remove: [word: string];
  openLogic: [logic: number, line: number];
  response: [room: number, command: string];
  task: [task: WordsTask];
  chat: [];
  guided: [action: WorkspaceAction];
}>();
const engine = useEngineApi();
void engine.loadPlayerSentences();
const editor = useWorkspaceEditor();
const ai = useAiSettings();
const copy = WORDS_EDITOR_COPY;
const adding = ref<number>();
const more = ref(false);
const taskProblems = ref<Record<string, string>>({});
const taskRequests = ref<Record<string, WordsTask>>({});
const toast = ref("");
let retired = false;
onBeforeUnmount(() => {
  retired = true;
});

const roomName = computed(
  () =>
    engine.roomMap.graph.value.nodes.find((node) => node.room === props.room)?.title ||
    editor.parts.value
      .find((part) => part.id === `logic:${props.room}`)
      ?.title.split(" · ROOM ")[0] ||
    `ROOM ${props.room}`,
);
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
watch(sentence, () => {
  more.value = false;
});
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
const pendingTask = ref<WordsTask>();
const predictOpen = ref(false);
const dismissedTask = ref(false);
const groups = computed(() => {
  const rows = wordGroups(entries.value).map((group) => {
    const head =
      uses.value[String(group.id)]
        ?.flatMap((use) => use.words)
        .find((word) => group.words.includes(word)) ?? group.words[0];
    return {
      ...group,
      usage: formatMeaningUses(uses.value[String(group.id)] ?? []),
      words: head ? [head, ...group.words.filter((word) => word !== head)] : group.words,
    };
  });
  for (const id of [0, ...empty.value])
    if (!rows.some((row) => row.id === id))
      rows.push({ id, words: [], usage: formatMeaningUses([]) });
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
const teaching = ref<{ word: string; room: number; row?: number }>();
const teachCommand = ref("");
const teachResponse = ref("");
const teachAlso = ref<readonly string[]>([]);
const teachMeaning = ref("new");
const sameMeaning = ref("");
const teachAction = computed<WorkspaceAction | undefined>(() =>
  teaching.value
    ? {
        kind: "response",
        room: teaching.value.room,
        command: teachCommand.value,
        response: teachResponse.value || "Your answer.",
        alsoCommands: teachAlso.value,
        teach: {
          word: teaching.value.word,
          ...(teachMeaning.value === "same" ? { sameAs: Number(sameMeaning.value) } : {}),
        },
      }
    : undefined,
);
const teachPreview = computed(() => {
  if (!teachAction.value) return undefined;
  try {
    return prepareWorkspaceAction(props.snapshot, props.profile.id, teachAction.value);
  } catch {
    return { ok: false as const, message: "Check Problems before adding this answer." };
  }
});
const teachWords = computed(() => {
  const prepared = teachPreview.value;
  const words = prepared?.ok
    ? prepared.changes.find((change) => change.key === "words")?.content
    : undefined;
  return typeof words === "string" ? (JSON.parse(words) as WordRows) : entries.value;
});
watch(entries, (words) => {
  if (teaching.value && words.some(([word]) => word === teaching.value!.word))
    teaching.value = undefined;
});
function label(id: number | undefined): string {
  return groups.value.find((group) => group.id === id)?.words[0] ?? String(id ?? "");
}
function write(next: WordRows): void {
  if (props.readOnly) return;
  try {
    buildWordsTok(next.map(([word, id]) => ({ word, id })));
    error.value = "";
    emit("edit", JSON.stringify(next));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
function addWord(id: number, value?: string): void {
  if (props.readOnly) return;
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
  if (props.readOnly) return;
  if (event.key === "Enter") {
    event.preventDefault();
    addWord(id);
  } else if (event.key === "Backspace" && !drafts.value[String(id)] && words.length) {
    event.preventDefault();
    emit("remove", words.at(-1)!);
  }
}
async function addMeaning(word?: string): Promise<void> {
  if (props.readOnly) return;
  const id = nextWordGroup([...entries.value, ...empty.value.map((group) => ["", group] as const)]);
  empty.value.push(id);
  adding.value = id;
  find.value = "";
  if (word) addWord(id, word);
  await nextTick();
  document.querySelector<HTMLInputElement>(`[data-word-group="${id}"] input`)?.focus();
}
async function openAdd(id: number): Promise<void> {
  if (props.readOnly) return;
  adding.value = id;
  await nextTick();
  document.querySelector<HTMLInputElement>(`[data-word-group="${id}"] .add-word`)?.focus();
}
function addAll(id: number): void {
  if (props.readOnly) return;
  const words = (ghosts.value[String(id)] ?? []).filter(
    (word) => !entries.value.some(([existing]) => existing === word),
  );
  write([...entries.value, ...words.map((word) => [word, id] as const)]);
  if (!error.value) ghosts.value[String(id)] = [];
}
function drop(event: DragEvent, to: number): void {
  if (props.readOnly) return;
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
  if (props.readOnly) return;
  event.dataTransfer?.setData("application/x-agi-word", JSON.stringify({ from, word }));
}
function move(): void {
  if (props.readOnly) return;
  const value = moving.value;
  if (!value || value.from === value.to) return;
  emit("move", { from: value.from, to: value.to, ...(value.merge ? {} : { word: value.word }) });
  moving.value = undefined;
}
function teach(word: string, entry?: PlayerSentence): void {
  if (props.readOnly) return;
  teaching.value = {
    word,
    room: entry?.room ?? props.room,
    ...(entry ? { row: tried.value.indexOf(entry) } : {}),
  };
  teachCommand.value = entry?.text ?? sentence.value;
  teachMeaning.value = "new";
  sameMeaning.value = "";
  teachResponse.value = "";
  teachAlso.value = [];
}
function addAnswer(): void {
  if (!props.readOnly && teachAction.value && teachPreview.value?.ok)
    emit("guided", teachAction.value);
}
async function task(value: WordsTask): Promise<void> {
  if (props.readOnly) return;
  if (value.kind !== "suggest") value = { ...value, roomName: roomName.value };
  if (value.kind === "review") {
    emit("task", value);
    return;
  }
  if (pendingTask.value) return;
  if (!ai.aiConfigured.value) {
    await ai.openAiSettings(null, "assistant");
    return;
  }
  const key = value.kind === "suggest" ? String(value.group) : "predict";
  const source = props.source;
  const modelLabel = ai.aiModelLabel.value;
  const room = props.room;
  taskRequests.value[key] = value;
  taskProblems.value[key] = "";
  pendingTask.value = value;
  dismissedTask.value = false;
  if (value.kind === "suggest") ghosts.value[key] = [];
  else {
    predictions.value = [];
    predictOpen.value = true;
  }
  try {
    await editor.flush.value?.();
    const result = await runWordsTask({
      task:
        value.kind === "predict"
          ? {
              ...value,
              pictures: engine.roomMap.resources.value.scans.get(room)?.pictures ?? [],
            }
          : value,
      documents: props.documents,
      engine,
      config: ai.llmConfig,
    });
    if (retired || dismissedTask.value) return;
    if (source !== props.source || room !== props.room) {
      taskProblems.value[key] = copy.changed;
      return;
    }
    taskProblems.value[key] = result.problem;
    if (value.kind === "suggest") {
      ghosts.value[key] = result.values.filter(
        (word) => !entries.value.some(([existing]) => existing === word),
      );
      if (result.values.length && !ghosts.value[key]!.length)
        taskProblems.value[key] = copy.existing;
    } else predictions.value = result.values;
    if (result.values.length) toast.value = copy.suggestionsFrom.replace("{model}", modelLabel);
  } catch (cause) {
    if (!retired && !dismissedTask.value)
      taskProblems.value[key] = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pendingTask.value = undefined;
  }
}
function typeInGame(): void {
  engine.sendInput(sentence.value);
}
function dismissGhosts(event: KeyboardEvent): void {
  if (
    !moving.value &&
    !teaching.value &&
    adding.value === undefined &&
    !more.value &&
    !predictOpen.value &&
    !pendingTask.value &&
    !Object.values(ghosts.value).some((words) => words.length) &&
    !Object.values(taskProblems.value).some(Boolean)
  )
    return;
  event.stopPropagation();
  dismissedTask.value = true;
  ghosts.value = {};
  taskProblems.value = {};
  predictions.value = [];
  predictOpen.value = false;
  adding.value = undefined;
  more.value = false;
  moving.value = undefined;
  teaching.value = undefined;
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
      <UiButton
        size="sm"
        icon="sparkles"
        :disabled="readOnly || !!pendingTask"
        :title="
          readOnly
            ? 'Editing is paused in this tab'
            : pendingTask
              ? copy.suggesting
              : VOCABULARY.predictCommands.help
        "
        @click="task({ kind: 'predict', room })"
        >{{ VOCABULARY.predictCommands.label }}</UiButton
      >
      <UiButton
        size="sm"
        @click="addMeaning()"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        >{{ VOCABULARY.meaningButton.label }}</UiButton
      >
    </header>
    <div v-if="toast" class="words-toast" role="status">
      {{ toast }} · <button class="words-link" @click="emit('chat')">{{ copy.openChat }}</button>
      <button class="chip-remove" aria-label="Close" @click="toast = ''">
        <UiIcon name="x" :size="16" />
      </button>
    </div>
    <p v-if="error" class="words-error" role="alert">{{ error }}</p>
    <form v-if="moving" class="words-choice" @submit.prevent="move" aria-label="Move to…">
      <strong>{{ VOCABULARY.moveWord.label }} {{ moving.word }}</strong>
      <select
        v-model.number="moving.to"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        aria-label="Destination meaning"
      >
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
      <label
        ><input
          v-model="moving.merge"
          :disabled="readOnly"
          :title="readOnly ? 'Editing is paused in this tab' : undefined"
          type="checkbox"
        />Merge the whole meaning</label
      >
      <p>LOGIC references keep the surviving meaning.</p>
      <UiButton
        type="submit"
        size="sm"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        >{{ moving.merge ? "Merge" : "Move" }}</UiButton
      ><UiButton size="sm" variant="ghost" @click="moving = undefined">Cancel</UiButton>
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
                {{ copy.unknown.replace("{word}", unknown) }}
              </p>
              <div class="words-actions">
                <UiButton
                  size="sm"
                  variant="primary"
                  @click="teach(unknown)"
                  :disabled="readOnly"
                  :title="readOnly ? 'Editing is paused in this tab' : undefined"
                  >{{ copy.teach.replace("{word}", unknown) }}</UiButton
                >
                <div class="tester-more">
                  <UiButton
                    size="sm"
                    variant="ghost"
                    trailing-icon="chevron-down"
                    :aria-expanded="more"
                    @click="more = !more"
                    >{{ copy.more }}</UiButton
                  >
                  <div v-if="more" class="tester-menu">
                    <UiButton
                      size="sm"
                      variant="ghost"
                      @click="
                        addMeaning(unknown);
                        more = false;
                      "
                      :disabled="readOnly"
                      :title="readOnly ? 'Editing is paused in this tab' : undefined"
                      >{{ copy.newMeaning }}</UiButton
                    >
                    <UiButton
                      size="sm"
                      variant="ghost"
                      @click="
                        addWord(0, unknown);
                        more = false;
                      "
                      :disabled="readOnly"
                      :title="readOnly ? 'Editing is paused in this tab' : undefined"
                      >{{ copy.skip }}</UiButton
                    >
                  </div>
                </div>
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
              <UiButton
                size="sm"
                @click="!readOnly && emit('response', room, sentence)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                >{{ VOCABULARY.addResponse.label }}</UiButton
              ></template
            >
          </div>
          <Teleport
            v-if="teaching"
            :disabled="teaching.row === undefined"
            :to="teaching.row === undefined ? 'body' : `#teach-row-${teaching.row}`"
          >
            <form
              class="teach-form"
              :aria-label="`Teach ${teaching.word}`"
              @submit.prevent="addAnswer"
            >
              <h4>What is {{ teaching.word }}?</h4>
              <div class="teach-meaning">
                <label
                  ><input v-model="teachMeaning" value="new" type="radio" :disabled="readOnly" /> A
                  new thing</label
                >
                <label
                  ><input v-model="teachMeaning" value="same" type="radio" :disabled="readOnly" />
                  Same as…</label
                >
                <select
                  v-if="teachMeaning === 'same'"
                  v-model="sameMeaning"
                  aria-label="Same meaning"
                  :disabled="readOnly"
                  required
                >
                  <option value="" disabled>Pick a meaning</option>
                  <option
                    v-for="group in groups.filter((row) => ![0, 1, 9999].includes(row.id))"
                    :key="group.id"
                    :value="String(group.id)"
                  >
                    {{ group.words.join(", ") }}
                  </option>
                </select>
              </div>
              <SentenceFields
                v-model:command="teachCommand"
                v-model:response="teachResponse"
                v-model:also="teachAlso"
                :words="teachWords"
                :disabled="readOnly"
              />
              <details v-if="teachResponse && teachPreview?.ok" open>
                <summary>LOGIC to add</summary>
                <pre data-testid="guided-code-preview">{{
                  teachPreview.showCode.map((preview) => preview.text).join("\n")
                }}</pre>
              </details>
              <p v-else-if="teachResponse && teachPreview && !teachPreview.ok" role="status">
                {{ teachPreview.message }}
              </p>
              <UiButton
                size="sm"
                type="submit"
                :disabled="readOnly || !teachPreview?.ok"
                :title="
                  readOnly
                    ? 'Editing is paused in this tab'
                    : teachPreview && !teachPreview.ok
                      ? teachPreview.message
                      : undefined
                "
                >Add</UiButton
              >
              <UiButton size="sm" variant="ghost" @click="teaching = undefined">Cancel</UiButton>
            </form>
          </Teleport>
        </div>
      </section>
      <section v-if="predictOpen" class="words-predictions" aria-label="Predicted commands">
        <div class="words-section">
          <h3>✦ Players will likely try in {{ roomName }}</h3>
          <UiButton
            size="sm"
            @click="
              predictions = [];
              predictOpen = false;
              dismissedTask = true;
            "
            >{{ copy.dismiss }}</UiButton
          >
        </div>
        <p v-if="pendingTask?.kind === 'predict'">{{ copy.suggesting }}</p>
        <div v-if="taskProblems['predict']" class="words-error" role="alert">
          {{ taskProblems["predict"] }}
          <button
            class="words-link"
            :disabled="readOnly || !!pendingTask"
            :title="
              readOnly
                ? 'Editing is paused in this tab'
                : pendingTask
                  ? copy.suggesting
                  : copy.retry
            "
            @click="task(taskRequests['predict']!)"
          >
            {{ copy.retry }}
          </button>
        </div>
        <div v-for="prediction in predictionRows" :key="prediction.command" class="tried-row">
          <code class="prediction-ghost">✦ {{ prediction.command }}</code
          ><small>{{ prediction.answered ? "✓ " : "○ " }}{{ prediction.description }}</small>
          <UiButton
            v-if="!prediction.answered"
            size="sm"
            @click="!readOnly && emit('response', room, prediction.command)"
            :disabled="readOnly"
            :title="readOnly ? 'Editing is paused in this tab' : undefined"
            >{{ VOCABULARY.addResponse.label }}</UiButton
          >
        </div>
        <UiButton
          v-if="predictions.length"
          size="sm"
          :disabled="readOnly || predictionRows.every((row) => row.answered)"
          :title="
            readOnly
              ? 'Editing is paused in this tab'
              : 'Choose commands with a response gap to review'
          "
          @click="
            task({
              kind: 'review',
              room,
              commands: predictionRows.filter((row) => !row.answered).map((row) => row.command),
            })
          "
          >{{ copy.addAll }}</UiButton
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
            v-for="(entry, index) in tried"
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
              <UiButton
                v-if="entry.unknown"
                size="sm"
                @click="teach(entry.unknown, entry)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                >{{ copy.teach.replace("{word}", entry.unknown) }}</UiButton
              ><UiButton
                size="sm"
                @click="!readOnly && emit('response', entry.room, entry.text)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                >{{ VOCABULARY.addResponse.label }}</UiButton
              ><button
                class="chip-remove"
                :aria-label="`Dismiss ${entry.text}`"
                @click="!readOnly && engine.resolvePlayerSentence(entry)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
              >
                <UiIcon name="x" :size="16" />
              </button>
            </div>
            <div :id="`teach-row-${index}`" class="tried-teach"></div>
          </div>
        </div>
      </section>
      <section :aria-label="VOCABULARY.meanings.label">
        <div class="words-section">
          <h3>
            <UiExplain
              term="words-meanings"
              :name="VOCABULARY.meanings.label"
              :says="VOCABULARY.meanings.help"
              technical="Stored as a word group in WORDS.TOK."
              >{{ VOCABULARY.meanings.label }}</UiExplain
            >
          </h3>
          <small>{{ meanings.length }}</small
          ><small class="words-order">{{ VOCABULARY.orderWords.label }}</small>
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
              :draggable="!readOnly"
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
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
              >
                <UiIcon name="external-link" :size="16" /></button
              ><button
                class="chip-remove"
                :aria-label="`Remove ${word}`"
                @click="!readOnly && emit('remove', word)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
              >
                <UiIcon name="x" :size="16" /></button
            ></span>
            <button
              v-for="word in ghosts[String(group.id)] ?? []"
              :key="word"
              class="word-chip word-suggestion"
              @click="addWord(group.id, word)"
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : undefined"
            >
              <UiIcon name="sparkles" :size="16" /> {{ word }}
            </button>
            <template v-if="ghosts[String(group.id)]?.length">
              <button
                class="words-link"
                @click="addAll(group.id)"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
              >
                {{ copy.addAll }}
              </button>
              <button class="words-link" @click="ghosts[String(group.id)] = []">
                {{ copy.dismiss }}
              </button>
            </template>
            <button
              v-if="adding !== group.id"
              class="word-chip row-action"
              :aria-label="VOCABULARY.addWord.label"
              @click="openAdd(group.id)"
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : undefined"
            >
              +
            </button>
            <input
              v-if="adding === group.id"
              v-model="drafts[String(group.id)]"
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : undefined"
              class="add-word row-action"
              :aria-label="`${VOCABULARY.addWord.label}: ${group.words.join(', ') || VOCABULARY.wordGroup.label}`"
              :placeholder="VOCABULARY.addWord.label"
              @keydown="wordKey($event, group.id, group.words)"
            />
            <button
              v-if="pendingTask?.kind !== 'suggest' || pendingTask.group !== group.id"
              class="words-link suggest row-action"
              :disabled="readOnly || !!pendingTask"
              :title="
                readOnly
                  ? 'Editing is paused in this tab'
                  : pendingTask
                    ? copy.suggesting
                    : VOCABULARY.suggestWords.help
              "
              @click="task({ kind: 'suggest', group: group.id, words: group.words })"
            >
              <UiIcon name="sparkles" :size="16" /> {{ VOCABULARY.suggestWords.label }}
            </button>
            <span v-else class="words-note">{{ copy.suggesting }}</span>
            <div v-if="taskProblems[String(group.id)]" class="words-error" role="alert">
              {{ taskProblems[String(group.id)] }}
              <button
                class="words-link"
                :disabled="readOnly || !!pendingTask"
                :title="
                  readOnly
                    ? 'Editing is paused in this tab'
                    : pendingTask
                      ? copy.suggesting
                      : copy.retry
                "
                @click="task(taskRequests[String(group.id)]!)"
              >
                {{ copy.retry }}
              </button>
            </div>
          </div>
          <div class="meaning-uses">
            <template v-if="group.usage.locations.length">
              <span>{{ group.usage.count }}</span>
              <span v-for="location in group.usage.locations" :key="location.logic">
                · {{ location.label }}
                <template v-for="(line, index) in location.lines" :key="line"
                  ><span v-if="index">, </span
                  ><a
                    class="words-link"
                    :href="`#logic-${location.logic}-line-${line}`"
                    :aria-label="`LOGIC ${location.logic} line ${line}`"
                    @click.prevent="emit('openLogic', location.logic, line)"
                    >{{ line }}</a
                  ></template
                >
              </span> </template
            ><template v-else
              ><small>{{ VOCABULARY.readyResponse.label }}</small
              ><UiButton
                size="sm"
                @click="!readOnly && emit('response', room, group.words[0] ?? '')"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                >{{ VOCABULARY.addResponse.label }}</UiButton
              ></template
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
            :draggable="!readOnly"
            @dragstart="drag($event, 0, word)"
            >{{ word
            }}<button
              class="chip-move"
              :aria-label="`${VOCABULARY.moveWord.label} ${word}`"
              @click="moving = { from: 0, word, to: meanings[0]?.id ?? 2, merge: false }"
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : undefined"
            >
              <UiIcon name="external-link" :size="16" /></button
            ><button
              class="chip-remove"
              :aria-label="`Remove ${word}`"
              @click="!readOnly && emit('remove', word)"
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : undefined"
            >
              <UiIcon name="x" :size="16" /></button></span
          ><button
            v-if="adding !== 0"
            class="word-chip row-action"
            :aria-label="VOCABULARY.addWord.label"
            @click="openAdd(0)"
            :disabled="readOnly"
            :title="readOnly ? 'Editing is paused in this tab' : undefined"
          >
            +</button
          ><input
            v-if="adding === 0"
            v-model="drafts['0']"
            :disabled="readOnly"
            :title="readOnly ? 'Editing is paused in this tab' : undefined"
            class="add-word row-action"
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
          ><UiExplain
            :term="`reserved-word-${id}`"
            :name="id === 1 ? VOCABULARY.anyWord.label : VOCABULARY.restOfLine.label"
            :says="id === 1 ? VOCABULARY.anyWord.help : VOCABULARY.restOfLine.help"
            :technical="`Reserved WORDS.TOK group ${id}.`"
            >{{ id === 1 ? "anyword" : "rest of line" }}</UiExplain
          ></span
        >
      </footer>
    </div>
  </div>
</template>
<style scoped>
.teach-form {
  padding: var(--space-3);
  margin-top: var(--space-3);
  border: 1px solid var(--action-line);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.teach-form h4 {
  margin: 0 0 var(--space-2);
}
.teach-meaning {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.teach-meaning label {
  display: flex;
  gap: var(--space-1);
  align-items: center;
}
.teach-form pre {
  overflow: auto;
  font: var(--text-xs) var(--font-mono);
  max-height: 160px;
}
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
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
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
.meaning-chips {
  position: relative;
  flex: 1;
}
.meaning-uses {
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--ink-3);
}
.word-id {
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  min-width: var(--space-6);
}
.word-chip {
  position: relative;
  font-family: var(--font-mono);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  box-sizing: border-box;
  height: var(--space-7);
  padding: 0 var(--space-3);
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
  border-color: var(--action-line);
  border-style: dashed;
  background: transparent;
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
  position: absolute;
  top: 0;
  z-index: 2;
  height: 100%;
  pointer-events: none;
  border-radius: var(--radius-pill);
  padding: 0 var(--space-1);
  background: var(--surface-3);
}
.word-chip .chip-remove {
  right: 0;
}
.word-chip .chip-move {
  right: var(--space-5);
}
.word-chip:has(.chip-remove):hover,
.word-chip:has(.chip-remove):focus-within {
  padding-right: calc(var(--space-3) + var(--space-8));
}
.word-chip:hover .chip-remove,
.word-chip:hover .chip-move,
.word-chip:focus-within .chip-remove,
.word-chip:focus-within .chip-move {
  opacity: 1;
  pointer-events: auto;
  padding: 0 var(--space-1);
}
@media (hover: none) {
  .word-chip .chip-remove,
  .word-chip .chip-move {
    opacity: 1;
    pointer-events: auto;
    padding: 0 var(--space-1);
  }
  .word-chip:has(.chip-remove) {
    padding-right: calc(var(--space-3) + var(--space-8));
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
  width: auto;
  min-width: 0;
  height: var(--space-7);
  border-style: dashed;
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
}
/* Row actions keep their place and fade in, so hovering a row never moves its chips. */
.row-action {
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.meaning-row:hover .row-action,
.meaning-row:focus-within .row-action,
.skipped-words:hover .row-action,
.skipped-words:focus-within .row-action {
  opacity: 1;
  pointer-events: auto;
}
.words-toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  font-size: var(--text-xs);
  color: var(--ink-3);
}
.words-toast .chip-remove {
  margin-left: auto;
}
.tester-more {
  position: relative;
}
.tester-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 1;
  display: grid;
  padding: var(--space-1);
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
}
.prediction-ghost {
  border: 1px dashed var(--action-line);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  color: var(--action);
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

<style scoped>
.tried-row {
  flex-wrap: wrap;
}
.tried-teach {
  flex-basis: 100%;
}
</style>
