import type { EngineApi } from "../../engine/engineContext.ts";
import type { LlmConfig } from "../../agent/llmClient.ts";
import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";
import { WORDS_REPLY_COPY } from "../../../../src/vocabulary.ts";
import type { ReplyFormatter } from "../../agent/workspaceAgent.ts";

export type WordsTask =
  | { kind: "suggest"; group: number; words: readonly string[] }
  | { kind: "predict"; room: number; roomName?: string; pictures?: readonly number[] }
  | {
      kind: "review";
      room: number;
      roomName?: string;
      commands: readonly string[];
      pictures?: readonly number[];
    };
export function wordsTaskPrompt(
  task: WordsTask,
  documents: Readonly<Record<string, ProjectContent>>,
): string {
  if (task.kind === "suggest")
    return `Suggest synonyms for WORDS.TOK meaning ${task.group}: ${task.words.join(", ")}. Propose only words with the same meaning. Preserve existing group numbers. Return a JSON object {"synonyms":["word"]} in your closing reply. These are editor suggestions to accept as chips. Read the current WORDS and said uses for context.`;
  const context = Object.entries(documents)
    .filter(
      ([key]) =>
        ["inventory", "words", `logic:${task.room}`, "logic:0"].includes(key) ||
        (task.pictures ?? []).some((picture) => key === `picture:${picture}`),
    )
    .map(
      ([key, content]) =>
        `${key.startsWith("picture:") ? "PICTURE" : key === "inventory" ? "OBJECT" : key} ${key}\n${typeof content === "string" ? content : "Native resource; read its description using the resource tools."}`,
    )
    .join("\n\n");
  if (task.kind === "review")
    return `Prepare WORDS.TOK and LOGIC changes for review in ROOM ${task.room} to answer these commands: ${task.commands.join("; ")}. Preserve existing group numbers and use real AGI said() responses.\n\n${context}`;
  return `Predict commands players will likely try in ROOM ${task.room}. Read its PICTURE description, objects, messages and LOGIC, including LOGIC 0. Resolve the room’s draw.pic bindings if its PICTURE is selected at runtime. Return a JSON object {"commands":["look tree"]} in your closing reply. Propose commands only; the editor checks responses and the builder chooses gaps to review.\n\n${context}`;
}
export function wordsTaskRequest(
  task: WordsTask,
  documents: Readonly<Record<string, ProjectContent>>,
): { text: string; context: string } {
  const text =
    task.kind === "suggest"
      ? `Suggest words for ${task.words[0] ?? `meaning ${task.group}`}`
      : task.kind === "predict"
        ? `Predict what players will try in ${task.roomName ?? `ROOM ${task.room}`}`
        : `Add responses in ${task.roomName ?? `ROOM ${task.room}`}: ${task.commands.join("; ")}`;
  return { text, context: wordsTaskPrompt(task, documents) };
}
export function readWordSuggestions(reply: string, kind: WordsTask["kind"]): string[] {
  return parseWordSuggestions(reply, kind) ?? [];
}
function parseWordSuggestions(reply: string, kind: WordsTask["kind"]): string[] | null {
  try {
    const start = reply.indexOf("{");
    const end = reply.lastIndexOf("}");
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    if (typeof value !== "object" || value === null) return null;
    const rows = (value as Record<string, unknown>)[kind === "suggest" ? "synonyms" : "commands"];
    if (!Array.isArray(rows)) return null;
    return [
      ...new Set(
        rows.filter(
          (word): word is string => typeof word === "string" && /^[a-z][a-z ]{0,79}$/.test(word),
        ),
      ),
    ].slice(0, 30);
  } catch {
    return null;
  }
}
export function wordsTaskReply(reply: string, task: WordsTask): ReturnType<ReplyFormatter> {
  if (task.kind === "review") return { text: reply };
  const values = parseWordSuggestions(reply, task.kind);
  const copy = WORDS_REPLY_COPY;
  let text: string;
  if (!values?.length) {
    const problem =
      values === null
        ? copy.unreadable
        : task.kind === "suggest"
          ? copy.emptyWords
          : copy.emptyCommands;
    text = `${problem} ${task.kind === "suggest" ? copy.retrySuggest : copy.retryPredict}`;
  } else if (task.kind === "suggest") {
    text =
      values.length <= 3
        ? copy.suggested.replace("{words}", values.join(", "))
        : copy.suggestedCount.replace("{count}", String(values.length));
  } else {
    text = copy.predicted
      .replace("{count}", String(values.length))
      .replace("{commands}", values.length === 1 ? copy.command : copy.commands)
      .replace("{room}", () => task.roomName ?? `ROOM ${task.room}`);
  }
  return { text, context: reply };
}
/** One prefilled handoff point for the workspace's existing agent surface. */
export async function openWordsTask(input: {
  task: WordsTask;
  documents: Readonly<Record<string, ProjectContent>>;
  engine: EngineApi;
  compose(request: { text: string; context: string; formatReply?: ReplyFormatter }): void;
  configured: boolean;
  config: LlmConfig;
  setup(): void;
}): Promise<void> {
  if (!input.configured) {
    input.setup();
    return;
  }
  if (!input.engine.state.powerUp.open) await input.engine.openPowerUp(input.config);
  input.engine.state.powerUp.mode = input.task.kind === "review" ? "remix" : "ask";
  input.compose({
    ...wordsTaskRequest(input.task, input.documents),
    ...(input.task.kind === "review"
      ? {}
      : { formatReply: (reply: string) => wordsTaskReply(reply, input.task) }),
  });
}
