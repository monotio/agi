/** App navigation and coordinated renames use the shared LOGIC server. */
import { createLogicLspServer, type LogicLanguageProject } from "../../../src/logic/lspServer.ts";
import type { ProjectSnapshot } from "../../../src/authoring/projectModel.ts";
import { readBindingsDocument } from "../../../src/authoring/projectDocuments.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { offsetAt, type WorkspaceEdit } from "../../../src/logic/lspTypes.ts";
import { projectOperandInfos, type BindingInfo } from "../../../src/logic/projectNames.ts";
import { numberedLabel, documentLabel } from "../../../src/logic/numberedLabels.ts";
import { systemName, systemMeaning } from "../../../src/logic/systemNames.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { EngineApi } from "../engine/engineContext.ts";

type NamesSnapshot = Pick<ProjectSnapshot, "read" | "keys" | "version">;

function namesProject(snapshot: NamesSnapshot, profileId: ProfileId): LogicLanguageProject {
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
  snapshot: NamesSnapshot,
  profileId: ProfileId,
): BindingInfo[] {
  const server = createLogicLspServer({ project: namesProject(snapshot, profileId) });
  return server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" })!.result as BindingInfo[];
}
export interface ReservedStateInfo extends BindingInfo {
  readonly meaning: string;
  readonly usage: string;
}
/** Both creator names and interpreter slots keep numeric order within each kind. */
export function workspaceGameStateInfos(
  snapshot: NamesSnapshot,
  profileId: ProfileId,
): {
  game: BindingInfo[];
  builtin: ReservedStateInfo[];
} {
  const project = namesProject(snapshot, profileId);
  const infos = workspaceOperandInfos(snapshot, profileId).filter(
    (info) => info.kind === "flag" || info.kind === "variable",
  );
  const game = infos.filter(
    (info) =>
      info.name &&
      Object.hasOwn(project.bindings, info.name) &&
      info.name !== systemName(info.kind, info.num),
  );
  game.sort((a, b) =>
    a.kind === b.kind
      ? a.num - b.num || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      : a.kind === "flag"
        ? -1
        : 1,
  );
  const builtin: ReservedStateInfo[] = [];
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
      builtin.push({
        name: numberedLabel(kind, num),
        kind,
        num,
        uses: unique,
        meaning: systemMeaning(kind, num)!,
        usage: [
          ...new Set(unique.map((use) => documentLabel(use.key, { bindings: project.bindings }))),
        ].join(", "),
      });
    }
  return { game, builtin };
}
function workspaceOperandInfos(snapshot: NamesSnapshot, profileId: ProfileId): BindingInfo[] {
  const project = namesProject(snapshot, profileId);
  const documents = { ...project.documents };
  for (const key of snapshot.keys) {
    const content = snapshot.read(key)?.content;
    if (key.startsWith("logic:") && content instanceof Uint8Array)
      documents[key] = {
        source: disassembleLogic(content, {
          profile: PROFILES[profileId],
          dictionary: new Map(project.words),
        }),
        version: snapshot.version(key),
      };
  }
  return projectOperandInfos({ ...project, documents });
}

/** Resolve literal operands with the same source inventory as named references. */
export function workspaceReferenceAt(
  snapshot: NamesSnapshot,
  profileId: ProfileId,
  key: string,
  position: { line: number; character: number },
): BindingInfo | undefined {
  return workspaceOperandInfos(snapshot, profileId).find((info) =>
    info.uses.some(
      (use) =>
        use.key === key &&
        use.range.start.line === position.line &&
        use.range.start.character <= position.character &&
        use.range.end.character >= position.character,
    ),
  );
}

/** Named aliases and literal slots share every use of the same operand. */
export function workspaceReferenceInfo(
  snapshot: NamesSnapshot,
  profileId: ProfileId,
  info: BindingInfo,
): BindingInfo {
  const uses = workspaceOperandInfos(snapshot, profileId)
    .filter(
      (entry) => entry.kind === info.kind && entry.num === info.num && entry.logic === info.logic,
    )
    .flatMap((entry) => entry.uses);
  return {
    ...info,
    uses: uses
      .filter(
        (use, index) =>
          uses.findIndex(
            (other) =>
              other.key === use.key &&
              other.range.start.line === use.range.start.line &&
              other.range.start.character === use.range.start.character,
          ) === index,
      )
      .map((use) => ({
        ...use,
        role:
          use.role === "Used" && (info.kind === "flag" || info.kind === "variable")
            ? ("Checked" as const)
            : use.role,
      }))
      .sort((a, b) =>
        a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : a.range.start.line - b.range.start.line ||
              a.range.start.character - b.range.start.character,
      ),
  };
}

/** Rename a name across the project from the current working copy, after pending edits save. */
export async function renameBindingInWorkspace(
  engine: EngineApi,
  flush: (() => Promise<unknown>) | undefined,
  name: string,
  newName: string,
): Promise<void> {
  await flush?.();
  const snapshot = engine.getProjectSession()?.workingSnapshot();
  if (!snapshot) throw new Error("Open a project to rename its parts.");
  await renameWorkspaceBinding(
    engine,
    snapshot,
    engine.roomMap.resources.value.profile?.id ?? "2.936",
    name,
    newName,
  );
}

async function renameWorkspaceBinding(
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
