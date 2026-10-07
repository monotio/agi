/** Portable language inputs from a decoded game/project archive. */
import { readInventoryObjects } from "./inventory.ts";
import { validateAuthoringState } from "./authoringState.ts";
import { readProjectWorkspace } from "./projectWorkspace.ts";
import { readBindingsDocument } from "./projectDocuments.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { parseWordsTok } from "../logic/words.ts";
import { openContainer } from "../container/container.ts";
import { detectProfile, type ProfileId } from "../runtime/profile.ts";

export function readProjectLanguageInput(input: {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profile?: ProfileId;
  readonly project?: {
    readonly authoringState?: Record<string, unknown> | undefined;
    readonly workspace?: unknown;
  };
}) {
  const files = new Map(Object.entries(input.files));
  const profile = detectProfile(files, input.profile);
  const container = openContainer(files, { profile });
  const dictionary = new Map(
    parseWordsTok(files.get("WORDS.TOK") ?? new Uint8Array()).map(({ word, id }) => [word, id]),
  );
  let inventory = readInventoryObjects(files.get("OBJECT"), profile);
  const state = input.project?.authoringState;
  let bindings = state?.["authoring"] ? validateAuthoringState(state["authoring"]).bindings : {};
  const sources: Record<string, string> = {};
  for (let num = 0; num < 256; num++) {
    const payload = container.getResource("logic", num);
    if (payload) sources[`logic:${num}`] = disassembleLogic(payload, { profile, dictionary });
  }
  const claims = (
    state?.["sources"] as { logics?: readonly (readonly [number, string])[] } | undefined
  )?.logics;
  for (const [num, source] of claims ?? []) sources[`logic:${num}`] = source;
  if (input.project?.workspace !== undefined) {
    const workspace = readProjectWorkspace(input.project.workspace);
    for (const [key, content] of Object.entries(workspace)) {
      if (key.startsWith("logic:") && typeof content === "string") sources[key] = content;
    }
    const bindingText = workspace["bindings"];
    if (typeof bindingText === "string") bindings = readBindingsDocument(bindingText);
    const content = workspace["inventory"];
    if (typeof content === "string") inventory = JSON.parse(content) as typeof inventory;
    else if (content instanceof Uint8Array) inventory = readInventoryObjects(content, profile);
    const words = workspace["words"];
    if (typeof words === "string") {
      dictionary.clear();
      for (const [word, id] of JSON.parse(words) as [string, number][]) dictionary.set(word, id);
    } else if (words instanceof Uint8Array) {
      dictionary.clear();
      for (const { word, id } of parseWordsTok(words)) dictionary.set(word, id);
    }
  }
  return {
    profile,
    dictionary,
    bindings,
    sources,
    inventory,
    objects: inventory.map((item) => item.name),
  };
}
