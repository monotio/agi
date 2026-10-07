/** App navigation and coordinated renames use the shared LOGIC server. */
import { createLogicLspServer, type LogicLanguageProject } from "../../../src/logic/lspServer.ts";
import type { ProjectSnapshot } from "../../../src/authoring/projectModel.ts";
import { readBindingsDocument } from "../../../src/authoring/projectDocuments.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { offsetAt, type WorkspaceEdit } from "../../../src/logic/lspTypes.ts";
import { projectOperandInfos, type BindingInfo } from "../../../src/logic/projectNames.ts";
import { systemName } from "../../../src/logic/systemNames.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { EngineApi } from "../engine/engineContext.ts";

function namesProject(snapshot: ProjectSnapshot, profileId: ProfileId): LogicLanguageProject {
  const words = snapshot.read("words")?.content;
  const bindings = snapshot.read("bindings")?.content;
  return {
    profileId,
    words:
      typeof words === "string"
        ? (JSON.parse(words) as [string, number][])
        : words
          ? parseWordsTok(words).map(({ word, id }) => [word, id])
          : [],
    bindings: typeof bindings === "string" ? readBindingsDocument(bindings) : {},
    documents: Object.fromEntries(
      snapshot.keys.flatMap((key) => {
        const document = snapshot.read(key);
        return key.startsWith("logic:") && typeof document?.content === "string"
          ? [[key, { source: document.content, version: document.version }]]
          : [];
      }),
    ),
    bindingDocument: {
      uri: "agi-project:///bindings.json",
      source: typeof bindings === "string" ? bindings : "{}",
    },
  };
}
export function workspaceBindingInfos(
  snapshot: ProjectSnapshot,
  profileId: ProfileId,
): BindingInfo[] {
  const server = createLogicLspServer({ project: namesProject(snapshot, profileId) });
  return server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" })!.result as BindingInfo[];
}
/** Game names keep code-point order; used interpreter slots keep numeric order. */
export function workspaceGameStateInfos(
  snapshot: ProjectSnapshot,
  profileId: ProfileId,
): {
  game: BindingInfo[];
  builtin: BindingInfo[];
} {
  const project = namesProject(snapshot, profileId);
  for (const key of snapshot.keys) {
    const content = snapshot.read(key)?.content;
    if (key.startsWith("logic:") && content instanceof Uint8Array)
      project.documents[key] = {
        source: disassembleLogic(content, {
          profile: PROFILES[profileId],
          dictionary: new Map(project.words),
        }),
        version: snapshot.version(key),
      };
  }
  const infos = projectOperandInfos(project).filter(
    (info) => info.kind === "flag" || info.kind === "variable",
  );
  const game = infos.filter((info) => info.name && systemName(info.kind, info.num) === undefined);
  const builtin: BindingInfo[] = [];
  for (const kind of ["flag", "variable"])
    for (let num = 0; num <= (kind === "flag" ? 15 : 26); num++) {
      const uses = infos
        .filter((info) => info.kind === kind && info.num === num)
        .flatMap((info) => info.uses);
      // The operand index can describe a literal both by name and by slot.
      const unique = uses.filter(
        (use, index) =>
          uses.findIndex(
            (other) =>
              other.key === use.key &&
              other.range.start.line === use.range.start.line &&
              other.range.start.character === use.range.start.character,
          ) === index,
      );
      if (unique.length) builtin.push({ name: systemName(kind, num)!, kind, num, uses: unique });
    }
  return { game, builtin };
}
export async function renameWorkspaceBinding(
  engine: EngineApi,
  base: ProjectSnapshot,
  profileId: ProfileId,
  name: string,
  newName: string,
): Promise<void> {
  const server = createLogicLspServer({ project: namesProject(base, profileId) });
  const response = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "agi/renameBinding",
    params: { name, newName },
  })!;
  if (response.error) throw new Error(response.error.message);
  const edit = response.result as WorkspaceEdit;
  const session = engine.getProjectSession();
  if (!session || session.workingSnapshot().revision !== base.revision)
    throw new Error("The project changed. Try Rename again.");
  const changes = edit.documentChanges.map((change) => {
    const key =
      change.textDocument.uri === "agi-project:///bindings.json"
        ? "bindings"
        : `logic:${/^agi-project:\/\/\/logic\.(\d+)\.lgc$/.exec(change.textDocument.uri)?.[1]}`;
    const source = base.read(key)?.content;
    if (typeof source !== "string") throw new Error("The source changed. Try Rename again.");
    let content = source;
    for (const entry of change.edits
      .map((edit) => ({
        start: offsetAt(source, edit.range.start),
        end: offsetAt(source, edit.range.end),
        text: edit.newText,
      }))
      .sort((a, b) => b.start - a.start)) {
      content = content.slice(0, entry.start) + entry.text + content.slice(entry.end);
    }
    return { key, content };
  });
  const outcome = await session.stage(changes);
  if (
    !["draft", "committed", "unchanged", "diagnostics", "restartRequired", "deferred"].includes(
      outcome.status,
    )
  )
    throw new Error("The game is waiting. Try Rename at the next game boundary.");
}
