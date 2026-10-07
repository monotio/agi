/** Detached coordinated renumbering; the project Update operation owns publication. */
import { readInventoryObjects } from "./inventory.ts";
import { decodeInventoryFile } from "../runtime/inventoryFile.ts";
import { MESSAGE_KEY } from "../logic/resource.ts";
import { renumberTestSetup, testSetupReferences } from "./renumberTestSetup.ts";
import type { GameTestSetup } from "../agent/gameTestSteps.ts";
import { collectLogicResourceUses } from "../logic/resourceUses.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { analyzeLogicSyntax } from "../logic/syntax.ts";
import { compileProjectLogic, expandProjectLogic } from "./projectLogic.ts";
import { readBindingsDocument } from "./projectDocuments.ts";
import {
  copyProjectDocuments,
  sameProjectContent,
  diffProjectDocuments,
  type ProjectContent,
} from "./projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ResourceKind } from "../types.ts";

export interface ComputedResourceUse {
  readonly document: string;
  readonly line: number;
  readonly command: string;
  readonly source: string;
}
type Documents = Readonly<Record<string, ProjectContent>>;
const KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;

function json<T>(documents: Documents, key: string): T | undefined {
  const content = documents[key];
  if (content === undefined) return undefined;
  return JSON.parse(typeof content === "string" ? content : new TextDecoder().decode(content)) as T;
}
interface World {
  rooms: Record<
    string,
    { title: string; description: string; exits: Record<string, number>; titleIsDefault?: true }
  >;
  launches?: Record<
    string,
    { entries: { cameFrom?: { room: number }; items?: Record<string, number> }[] }
  >;
}
interface StoredTest {
  room: number;
  setup?: GameTestSetup;
  expect?: { room?: number; object?: { view?: number } };
  steps: { until?: { room?: number; object?: { view?: number } } }[];
}
interface ArtReference {
  kind: string;
  target: number;
  staged?: { num: number };
}

/** Known targets include authored drafts and metadata reservations, even without stored resources. */
export function occupiedProjectNumbers(
  documents: Documents,
  kind: ResourceKind,
  profile: AgiProfile,
): ReadonlySet<number> {
  const used = new Set<number>();
  for (const key of Object.keys(documents))
    if (key.startsWith(`${kind}:`)) used.add(Number(key.split(":")[1]));
  const bindings = readBindingsDocument(
    typeof documents["bindings"] === "string" ? documents["bindings"] : "{}",
  );
  for (const binding of Object.values(bindings)) if (binding.kind === kind) used.add(binding.num);
  for (const [key, content] of Object.entries(documents))
    if (key.startsWith("logic:")) {
      const source =
        typeof content === "string"
          ? content
          : disassembleLogic(content, { profile, dictionary: new Map() });
      const expanded = expandProjectLogic(source, bindings, true);
      for (const use of collectLogicResourceUses(expanded.prelude + source, profile))
        if (use.kind === kind && use.number !== undefined) used.add(use.number);
    }
  const world = json<World>(documents, "world");
  if (kind === "logic" && world) {
    for (const [key, room] of Object.entries(world.rooms)) {
      used.add(Number(key));
      Object.values(room.exits).forEach((number) => used.add(number));
    }
    for (const [key, launches] of Object.entries(world.launches ?? {})) {
      used.add(Number(key));
      for (const launch of launches.entries) {
        if (launch.cameFrom) used.add(launch.cameFrom.room);
        for (const number of Object.values(launch.items ?? {}))
          if (number > 0 && number < 255) used.add(number);
      }
    }
  }
  for (const test of json<{ tests: StoredTest[] }>(documents, "tests")?.tests ?? []) {
    if (test.setup)
      for (const reference of testSetupReferences(test.setup, profile))
        if (reference.kind === kind) used.add(reference.num);
    if (kind === "logic") {
      used.add(test.room);
      if (test.expect?.room !== undefined) used.add(test.expect.room);
    }
    if (kind === "view" && test.expect?.object?.view !== undefined)
      used.add(test.expect.object.view);
    for (const step of test.steps) {
      if (kind === "logic" && step.until?.room !== undefined) used.add(step.until.room);
      if (kind === "view" && step.until?.object?.view !== undefined)
        used.add(step.until.object.view);
    }
  }
  for (const entry of json<ArtReference[]>(documents, "references") ?? []) {
    if (
      (kind === "logic" && entry.kind === "room") ||
      (kind === "view" && entry.kind === "character")
    )
      used.add(entry.target);
    if (kind === "view" && entry.staged) used.add(entry.staged.num);
  }
  if (kind === "sound")
    Object.keys(json<Record<string, unknown>>(documents, "music") ?? {}).forEach((key) =>
      used.add(Number(key)),
    );
  if (kind === "picture")
    Object.keys(
      json<{ traces: Record<string, unknown> }>(documents, "images")?.traces ?? {},
    ).forEach((key) => used.add(Number(key.split(":")[1])));
  if (kind === "logic")
    for (const item of documents["inventory"] instanceof Uint8Array
      ? readInventoryObjects(documents["inventory"], profile)
      : (json<{ startingRoom: number }[]>(documents, "inventory") ?? []))
      if (item.startingRoom > 0 && item.startingRoom < 255) used.add(item.startingRoom);
  return used;
}

export function prepareProjectRenumber(input: {
  readonly documents: Documents;
  readonly key: string;
  readonly number: number;
  readonly profile: AgiProfile;
}) {
  const match = KEY.exec(input.key);
  if (!match) return { ok: false as const, reason: "Choose a LOGIC, PICTURE, VIEW or SOUND." };
  const kind = match[1] as ResourceKind,
    old = Number(match[2]),
    next = input.number;
  const minimum = kind === "logic" ? 1 : 0;
  if (kind === "logic" && old === 0)
    return { ok: false as const, reason: "LOGIC 0 starts the game and keeps number 0." };
  if (!Number.isInteger(next) || next < minimum || next > 255)
    return { ok: false as const, reason: `Choose a whole number from ${minimum} to 255.` };
  const target = `${kind}:${next}`;
  if (next !== old && occupiedProjectNumbers(input.documents, kind, input.profile).has(next))
    return {
      ok: false as const,
      reason: `${kind.toUpperCase()} ${next} is already taken. Choose another number.`,
    };
  const documents = { ...copyProjectDocuments(input.documents) };
  const resource = documents[input.key];
  if (resource === undefined)
    return { ok: false as const, reason: "This part changed. Open it again." };
  if (next === old)
    return {
      ok: true as const,
      key: target,
      documents,
      changes: [],
      computed: [] as ComputedResourceUse[],
    };
  const bindings = readBindingsDocument(
    typeof documents["bindings"] === "string" ? documents["bindings"] : "{}",
  );
  const computed: ComputedResourceUse[] = [];
  for (const [key, content] of Object.entries(documents))
    if (key.startsWith("logic:")) {
      const native = typeof content !== "string";
      const source = native
        ? disassembleLogic(content, { profile: input.profile, dictionary: new Map() })
        : content;
      const expansion = expandProjectLogic(source, bindings, true);
      const locallyDefined = new Set(
        analyzeLogicSyntax(source).definitions.map((definition) => definition.name),
      );
      const edits = new Map<number, { end: number; text: string }>();
      for (const use of collectLogicResourceUses(expansion.prelude + source, input.profile)) {
        if (use.kind !== kind) continue;
        if (use.number === undefined) {
          const start = Math.max(0, use.start - expansion.authoredStart);
          const line = source.slice(0, start).split("\n").length;
          computed.push({
            document: key,
            line,
            command: use.command,
            source: source.split("\n")[line - 1] ?? use.command,
          });
        } else if (use.number === old && use.token && use.token.start >= expansion.authoredStart) {
          const token = use.token;
          // Project names keep their spelling: only their bindings move.
          if (
            token.type === "ident" &&
            Object.hasOwn(bindings, token.text) &&
            !locallyDefined.has(token.text)
          )
            continue;
          const prefix = /^([vfomsiwc])\d+$/.exec(token.text)?.[1] ?? "";
          edits.set(token.start - expansion.authoredStart, {
            end: token.end - expansion.authoredStart,
            text: `${prefix}${next}`,
          });
        }
      }
      let rewritten = source;
      for (const [start, edit] of [...edits].sort(([a], [b]) => b - a))
        rewritten = rewritten.slice(0, start) + edit.text + rewritten.slice(edit.end);
      if (rewritten !== source)
        documents[key] = native
          ? compileProjectLogic(rewritten, {
              profile: input.profile,
              dictionary: new Map(),
              bindings,
            }).assembly.payload
          : rewritten;
    }
  for (const binding of Object.values(bindings)) {
    if (binding.kind === kind && binding.num === old) binding.num = next;
    if (kind === "logic" && binding.kind === "message" && binding.logic === old)
      binding.logic = next;
    if (kind === "logic")
      for (const evidence of binding.evidence ?? [])
        if (evidence.logic === old) evidence.logic = next;
  }
  if (documents["bindings"] !== undefined) documents["bindings"] = JSON.stringify(bindings);
  const replace = (number: number) => (number === old ? next : number);
  const moveKey = (record: Record<string, unknown>, from: string, to: string) => {
    if (Object.hasOwn(record, from)) {
      record[to] = record[from];
      delete record[from];
    }
  };
  const world = json<World>(documents, "world");
  if (world && kind === "logic") {
    const movedRoom = world.rooms[String(old)];
    if (movedRoom?.titleIsDefault && movedRoom.title === `Room ${old}`)
      movedRoom.title = `Room ${next}`;

    moveKey(world.rooms, String(old), String(next));
    for (const room of Object.values(world.rooms))
      for (const name of Object.keys(room.exits)) room.exits[name] = replace(room.exits[name]!);
    if (world.launches) {
      moveKey(world.launches, String(old), String(next));
      for (const launches of Object.values(world.launches))
        for (const launch of launches.entries) {
          if (launch.cameFrom) launch.cameFrom.room = replace(launch.cameFrom.room);
          for (const key of Object.keys(launch.items ?? {}))
            if (old !== 255) launch.items![key] = replace(launch.items![key]!);
        }
    }
    documents["world"] = JSON.stringify(world);
  }
  documents[target] = documents[input.key]!;
  delete documents[input.key];
  const tests = json<{ tests: StoredTest[] }>(documents, "tests");
  if (tests) {
    for (const test of tests.tests) {
      if (test.setup)
        test.setup = renumberTestSetup({
          setup: test.setup,
          kind,
          from: old,
          to: next,
          profile: input.profile,
          documents,
        });
      if (kind === "logic") {
        test.room = replace(test.room);
        if (test.expect?.room !== undefined) test.expect.room = replace(test.expect.room);
      }
      if (kind === "view" && test.expect?.object?.view !== undefined)
        test.expect.object.view = replace(test.expect.object.view);
      for (const step of test.steps) {
        if (kind === "logic" && step.until?.room !== undefined)
          step.until.room = replace(step.until.room);
        if (kind === "view" && step.until?.object?.view !== undefined)
          step.until.object.view = replace(step.until.object.view);
      }
    }
    documents["tests"] = JSON.stringify(tests);
  }
  const references = json<ArtReference[]>(documents, "references");
  if (references) {
    for (const entry of references) {
      if (
        (kind === "logic" && entry.kind === "room") ||
        (kind === "view" && entry.kind === "character")
      )
        entry.target = replace(entry.target);
      if (kind === "view" && entry.staged) entry.staged.num = replace(entry.staged.num);
    }
    documents["references"] = JSON.stringify(references);
  }
  if (kind === "sound") {
    const music = json<Record<string, unknown>>(documents, "music");
    if (music) {
      moveKey(music, String(old), String(next));
      documents["music"] = JSON.stringify(music);
    }
  }
  if (kind === "picture") {
    const images = json<{ traces: Record<string, unknown> }>(documents, "images");
    if (images) {
      moveKey(images.traces, input.key, target);
      documents["images"] = JSON.stringify(images);
    }
  }
  if (kind === "logic" && old !== 255) {
    const native = documents["inventory"];
    if (native instanceof Uint8Array) {
      const plain = decodeInventoryFile(native, input.profile);
      const encoded = !sameProjectContent(native, plain);
      const size = plain[0]! | (plain[1]! << 8);
      for (
        let at = input.profile.inventoryHeaderBytes;
        at < input.profile.inventoryHeaderBytes + size;
        at += input.profile.inventoryEntryBytes
      )
        plain[at + 2] = replace(plain[at + 2]!);
      documents["inventory"] = encoded
        ? plain.map((byte, index) => byte ^ MESSAGE_KEY.charCodeAt(index % MESSAGE_KEY.length))
        : plain;
    } else {
      const inventory = json<{ startingRoom: number }[]>(documents, "inventory");
      if (inventory) {
        for (const item of inventory) item.startingRoom = replace(item.startingRoom);
        documents["inventory"] = JSON.stringify(inventory);
      }
    }
  }
  return {
    ok: true as const,
    key: target,
    documents,
    changes: diffProjectDocuments(input.documents, documents),
    computed,
  };
}

/** History can restore a reviewed move when the moved resource has the exact reverse rewrite. */
export function projectRenumberingBetween(
  before: Documents,
  after: Documents,
  profile: AgiProfile,
) {
  const removed = Object.keys(before).filter((key) => KEY.test(key) && after[key] === undefined);
  const added = Object.keys(after).filter((key) => KEY.test(key) && before[key] === undefined);
  if (
    removed.length !== 1 ||
    added.length !== 1 ||
    removed[0]!.split(":")[0] !== added[0]!.split(":")[0]
  )
    return undefined;
  const key = removed[0]!,
    number = Number(added[0]!.split(":")[1]);
  const plan = prepareProjectRenumber({ documents: before, key, number, profile });
  if (!plan.ok || !sameProjectContent(plan.documents[plan.key], after[plan.key])) return undefined;
  return { key, number };
}
