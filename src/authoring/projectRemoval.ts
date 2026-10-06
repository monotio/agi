/**
 * Removal admission review for a compiled project candidate: the inventory of
 * definite and potential uses that must be empty before a reviewed resource
 * deletion may Keep. compileProjectSelection already strict-compiles the
 * candidate and inventories its native image; this review adds the candidate's
 * authoring intent (bindings reservations, world room plans, music intent),
 * the preserved metadata documents it carries (stored tests and reference-art
 * associations) and every unselected open draft that could still name a
 * removed ID.
 *
 * LOGIC and PICTURE targets use room-flow analysis; other variable resource operands
 * block same-family removal. Input a checker
 * cannot enumerate — an unreadable document, damaged draft source, an opaque
 * test save image or an unrecognized references entry — refuses rather than
 * guesses. Approval matching, storage CAS and the durable write belong to the
 * calling service.
 */
import { parseGameTests, type GameTestsDocument } from "../agent/gameTestFormat.ts";
import { createRoomFlow, VAR_WRITES } from "../agent/roomFlow.ts";
import { openContainer } from "../container/container.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { validateAuthoringState, type AuthoringState } from "./authoringState.ts";
import { readBindingsDocument, readMusicDocument } from "./projectDocuments.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import { inspectProjectSourceDependencies } from "./projectSourceDependencies.ts";

type DocumentContent = string | Uint8Array;
type ImageInspection = ReturnType<typeof inspectProjectReferences>;
type BindingMap = AuthoringState["bindings"];

/** The document keys that name actual AGI resources; tagged sources like `music:7` are not. */
export const PROJECT_RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;

type ResourceKind = "logic" | "picture" | "view" | "sound";
interface RemovedResource {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly num: number;
}

/** One surviving or unprovable use that blocks a reviewed removal. */
export interface RemovalFinding {
  /** Where the use lives: a document key, `bindings`, `world`, `music` or a draft key. */
  readonly document: string;
  readonly message: string;
  readonly computedRoomJump?: string;
}

export interface ProjectRemovalInput {
  /** The candidate's native removals: exact keys computed from its own document set. */
  readonly removals: readonly string[];
  /** inspectProjectReferences over the candidate's compiled image. */
  readonly image: ImageInspection;
  /** The candidate's validated authoring intent: bindings, world and music. */
  readonly authoring: AuthoringState;
  /** The candidate's preserved stored-tests document, verbatim. */
  readonly tests: DocumentContent | undefined;
  /** The candidate's preserved reference-art metadata document, verbatim. */
  readonly references: DocumentContent | undefined;
  /**
   * Open draft edits not selected into this candidate, with content. An
   * unselected draft that still names a removed ID is a potential use; the
   * coordinated proposal must select and repair it instead.
   */
  readonly drafts: readonly { readonly key: string; readonly content: DocumentContent }[];
  /** The kept baseline's bindings: a second name-resolution context for drafts. */
  readonly keptBindings: BindingMap;
  readonly profile: AgiProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Report = (document: string, message: string, computedRoomJump?: string) => void;

function inspectFlowTargets(
  input: ProjectRemovalInput,
  removed: readonly RemovedResource[],
  report: Report,
): void {
  const resources = removed.filter(({ kind }) => kind === "logic" || kind === "picture");
  if (!resources.length) return;
  const flow = createRoomFlow(input.image.logics, input.profile, { admission: true });
  const rooms = new Set<number>();
  let currentRoomKnown = true;
  // Between invocations v0 holds boot's 0, a literal authored write, or a
  // new.room target. Close that set over the analyzed transitions rather than
  // assuming every existing LOGIC (including a newly created room) is reachable.
  // A computed write to v0 or an indirect write defeats this invariant. All
  // other entry variables retain the analysis' unknown bit across invocations.
  for (const insns of flow.instructions.values())
    for (const insn of insns) {
      if (insn.name === "assignn" && insn.args?.[0] === 0) rooms.add(insn.args[1]!);
      else if (
        ["lindirectn", "lindirectv"].includes(insn.name ?? "") ||
        (VAR_WRITES[insn.name ?? ""] ?? []).some((pos) => insn.args?.[pos] === 0)
      )
        currentRoomKnown = false;
    }
  const called = new Set<number>();
  const scannedRooms = new Set<number>();
  const inspect = (scan: ReturnType<typeof flow.scan>): void => {
    for (const callee of scan.calls) called.add(callee);
    for (const target of scan.targets) rooms.add(target.to);
    for (const use of scan.resourceUses)
      for (const { key, kind, num } of resources) {
        const document = `logic:${use.logic}`;
        if (use.kind === kind && use.targets.includes(num))
          report(
            document,
            `${key} is still used by ${document} at offset ${use.offset} (${use.command}).`,
          );
        if (use.unknown && kind === "logic" && use.command === "new.room.v") {
          const insns = flow.instructions.get(use.logic) ?? [];
          const jump = insns.find((insn) => insn.at === use.offset);
          const teleport = insns.some(
            (insn) => insn.name === "get.num" && insn.args?.[1] === jump?.args?.[0],
          );
          report(
            document,
            `Room ${num} can still be reached by a computed room jump in LOGIC ${use.logic}${teleport ? " (the debug teleport)" : ""}. Remove anyway?`,
            key,
          );
        } else if (use.unknown && (use.kind === kind || use.kind === "logic"))
          report(
            document,
            `${key} may still be used: ${document} at offset ${use.offset} (${use.command}) has a computed or unresolved ${use.kind.toUpperCase()} target.`,
          );
      }
  };
  const inspectRooms = (): void => {
    if (!currentRoomKnown || !input.image.logics.has(0)) return;
    // Set iteration visits newly resolved destinations as the closure grows.
    for (const room of rooms) {
      if (scannedRooms.has(room)) continue;
      scannedRooms.add(room);
      inspect(flow.scan(0, room, true));
    }
  };
  if (input.image.logics.has(0)) {
    inspect(currentRoomKnown ? flow.scan(0, 0, true, true) : flow.scan(0));
    inspectRooms();
  }
  // An uncalled resource can be an editor entry point. Analyze its targets as
  // well, while helpers already visited through callers keep those bindings.
  for (const num of input.image.logics.keys())
    if (num !== 0 && !called.has(num)) inspect(flow.scan(num));
  inspectRooms();
}

function inspectWorldPlan(
  document: string,
  world: AuthoringState["world"],
  removedKeys: ReadonlySet<string>,
  report: Report,
): void {
  for (const [num, room] of Object.entries(world.rooms)) {
    const key = `logic:${num}`;
    if (removedKeys.has(key))
      report(document, `${key} is still the planned room '${room.title || num}'.`);
    for (const [name, destination] of Object.entries(room.exits)) {
      const exit = `logic:${destination}`;
      if (removedKeys.has(exit))
        report(document, `${exit} is still the '${name}' exit of planned room ${num}.`);
    }
  }
}

function inspectBindingReservations(
  document: string,
  bindings: BindingMap,
  removedKeys: ReadonlySet<string>,
  report: Report,
): void {
  for (const [name, binding] of Object.entries(bindings)) {
    const key = `${binding.kind}:${binding.num}`;
    if (removedKeys.has(key))
      report(
        document,
        `${key} is still reserved by binding '${name}'; remove or reassign it in the same candidate.`,
      );
  }
}

function inspectMusicIntent(
  document: string,
  music: AuthoringState["music"],
  removedKeys: ReadonlySet<string>,
  report: Report,
): void {
  for (const num of Object.keys(music ?? {})) {
    const key = `sound:${num}`;
    if (removedKeys.has(key))
      report(
        document,
        `${key} still carries music intent; remove its entry in the same candidate.`,
      );
  }
}

function roomUse(room: unknown, removedKeys: ReadonlySet<string>): string | undefined {
  if (typeof room !== "number" || !Number.isInteger(room)) return undefined;
  const key = `logic:${room}`;
  return removedKeys.has(key) ? key : undefined;
}

/** Stored tests: literal room/view uses are definite; an opaque setup image or an unreadable file cannot be inventoried. */
function inspectTestsDocument(
  document: string,
  content: DocumentContent | undefined,
  removedKeys: ReadonlySet<string>,
  profile: AgiProfile,
  report: Report,
): void {
  if (content === undefined) return;
  let parsed: GameTestsDocument;
  try {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    parsed = parseGameTests(bytes, profile);
  } catch (error) {
    report(
      document,
      `${document} cannot be enumerated (${reason(error)}), so its uses cannot be inventoried.`,
    );
    return;
  }
  for (const test of parsed.tests) {
    const label = `test '${test.name}'`;
    if (test.setup !== undefined)
      report(document, `${label} restores a save image whose resource uses cannot be inventoried.`);
    const entered = roomUse(test.room, removedKeys);
    if (entered !== undefined) report(document, `${label} still enters ${entered}.`);
    const expected = roomUse(test.expect?.["room"], removedKeys);
    if (expected !== undefined) report(document, `${label} still expects ${expected}.`);
    const object = test.expect?.["object"];
    if (isRecord(object)) {
      const view = object["view"];
      if (typeof view === "number" && Number.isInteger(view) && removedKeys.has(`view:${view}`))
        report(document, `${label} still expects view:${view}.`);
    }
    for (const step of test.steps) {
      const until = step["until"];
      if (!isRecord(until)) continue;
      const waited = roomUse(until["room"], removedKeys);
      if (waited !== undefined) report(document, `${label} still waits for ${waited}.`);
    }
  }
}

const REFERENCE_FIELDS = [
  "id",
  "kind",
  "target",
  "brief",
  "images",
  "attachedAt",
  "origin",
  "stale",
  "sheet",
  "staged",
];

/**
 * Reference-art associations name their LOGIC room or staged VIEW target.
 * Entries whose shape this checker does not recognize may carry a resource use
 * it cannot see, so they refuse rather than pass silently.
 */
function inspectReferencesDocument(
  document: string,
  content: DocumentContent | undefined,
  removedKeys: ReadonlySet<string>,
  report: Report,
): void {
  if (content === undefined) return;
  if (typeof content !== "string") {
    report(document, `${document} is not JSON text, so its associations cannot be inventoried.`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    report(
      document,
      `${document} cannot be enumerated (${reason(error)}), so its associations cannot be inventoried.`,
    );
    return;
  }
  if (!Array.isArray(parsed)) {
    report(
      document,
      `${document} is not a reference list, so its associations cannot be inventoried.`,
    );
    return;
  }
  parsed.forEach((entry, index) => {
    const label = `${document} entry ${index}`;
    if (!isRecord(entry) || Object.keys(entry).some((key) => !REFERENCE_FIELDS.includes(key))) {
      report(document, `${label} has an unrecognized shape, so its uses cannot be inventoried.`);
      return;
    }
    const kind = entry["kind"];
    const target = entry["target"];
    if (
      (kind !== "room" && kind !== "character") ||
      typeof target !== "number" ||
      !Number.isInteger(target)
    ) {
      report(document, `${label} has an unrecognized shape, so its uses cannot be inventoried.`);
      return;
    }
    const key = kind === "room" ? `logic:${target}` : `view:${target}`;
    if (removedKeys.has(key))
      report(document, `${label} still targets ${key}; removing it would discard the association.`);
    const staged = entry["staged"];
    if (staged === undefined) return;
    if (isRecord(staged) && typeof staged["num"] === "number" && Number.isInteger(staged["num"])) {
      const stagedKey = `view:${staged["num"]}`;
      if (removedKeys.has(stagedKey))
        report(
          document,
          `${label} still stages ${stagedKey}; removing it would discard the association.`,
        );
    } else {
      report(
        document,
        `${label} has an unrecognized staged shape, so its uses cannot be inventoried.`,
      );
    }
  });
}

/**
 * The inventory a candidate's removals must pass. Returns every surviving or
 * unprovable use; an empty result means nothing definite and no same-family
 * potential use remains anywhere the review can enumerate.
 */
export function inspectProjectRemoval(input: ProjectRemovalInput): readonly RemovalFinding[] {
  const removed: RemovedResource[] = [];
  for (const key of input.removals) {
    const match = PROJECT_RESOURCE_KEY.exec(key);
    if (match !== null)
      removed.push({ key, kind: match[1] as ResourceKind, num: Number(match[2]) });
  }
  const removedKeys: ReadonlySet<string> = new Set(removed.map((entry) => entry.key));
  const findings: RemovalFinding[] = [];
  const seen = new Set<string>();
  const report: Report = (document, message, computedRoomJump) => {
    const marker = `${document}${message}`;
    if (seen.has(marker)) return;
    seen.add(marker);
    findings.push({
      document,
      message,
      ...(computedRoomJump === undefined ? {} : { computedRoomJump }),
    });
  };

  // LOGIC 0 is the interpreter's required entry point; removing it cannot be
  // repaired inside the candidate because the interpreter names the slot.
  if (removedKeys.has("logic:0"))
    report("logic:0", "logic:0 is the interpreter's required entry point and cannot be removed.");

  // The compiled candidate image is authoritative for kept code and every
  // selected repair: literal targets are definite uses and damaged documents
  // cannot be inventoried at all.
  for (const document of input.image.unknownDocuments)
    report(document, `${document} is damaged or unreadable, so its uses cannot be inventoried.`);
  for (const reference of input.image.references) {
    const target = reference.target;
    if ("variable" in target) {
      if (target.kind === "logic" || target.kind === "picture") continue;
      for (const { key, kind } of removed)
        if (kind === target.kind)
          report(
            reference.document,
            `${key} may still be used: ${reference.document} reads a ${kind} target from v${target.variable} (${reference.command}).`,
          );
      continue;
    }
    if (target.kind === "item" || target.kind === "word" || reference.document === "bindings")
      continue;
    const key = `${target.kind}:${target.num}`;
    if (removedKeys.has(key))
      report(
        reference.document,
        `${key} is still used by ${reference.document} (${reference.command}).`,
      );
  }

  inspectFlowTargets(input, removed, report);

  inspectBindingReservations("bindings", input.authoring.bindings, removedKeys, report);
  inspectWorldPlan("world", input.authoring.world, removedKeys, report);
  inspectMusicIntent("music", input.authoring.music, removedKeys, report);
  inspectTestsDocument("tests", input.tests, removedKeys, input.profile, report);
  inspectReferencesDocument("references", input.references, removedKeys, report);

  for (const draft of input.drafts) {
    const resource = PROJECT_RESOURCE_KEY.exec(draft.key);
    if (resource !== null) {
      if (resource[1] !== "logic") continue; // Picture, view and sound documents name no resources.
      if (typeof draft.content === "string") {
        inspectSourceDraft(draft.key, draft.content, removed, removedKeys, input, report);
      } else {
        inspectBytecodeDraft(
          draft.key,
          Number(resource[2]),
          draft.content,
          removed,
          removedKeys,
          input.profile,
          report,
        );
      }
      continue;
    }
    if (draft.key === "bindings") {
      if (typeof draft.content !== "string") {
        report(
          draft.key,
          `draft ${draft.key} is not JSON text, so its reservations cannot be inventoried.`,
        );
        continue;
      }
      try {
        inspectBindingReservations(
          draft.key,
          readBindingsDocument(draft.content),
          removedKeys,
          report,
        );
      } catch (error) {
        report(
          draft.key,
          `draft ${draft.key} cannot be enumerated (${reason(error)}), so its reservations cannot be inventoried.`,
        );
      }
      continue;
    }
    if (draft.key === "world") {
      if (typeof draft.content !== "string") {
        report(
          draft.key,
          `draft ${draft.key} is not JSON text, so its room plan cannot be inventoried.`,
        );
        continue;
      }
      try {
        const world = validateAuthoringState({
          version: 1,
          bindings: {},
          world: JSON.parse(draft.content),
        }).world;
        inspectWorldPlan(draft.key, world, removedKeys, report);
      } catch (error) {
        report(
          draft.key,
          `draft ${draft.key} cannot be enumerated (${reason(error)}), so its room plan cannot be inventoried.`,
        );
      }
      continue;
    }
    if (draft.key === "music") {
      if (typeof draft.content !== "string") {
        report(
          draft.key,
          `draft ${draft.key} is not JSON text, so its intent cannot be inventoried.`,
        );
        continue;
      }
      try {
        inspectMusicIntent(draft.key, readMusicDocument(draft.content), removedKeys, report);
      } catch (error) {
        report(
          draft.key,
          `draft ${draft.key} cannot be enumerated (${reason(error)}), so its intent cannot be inventoried.`,
        );
      }
      continue;
    }
    if (draft.key === "tests") {
      inspectTestsDocument(draft.key, draft.content, removedKeys, input.profile, report);
      continue;
    }
    if (draft.key === "references") {
      inspectReferencesDocument(draft.key, draft.content, removedKeys, report);
      continue;
    }
    // words and inventory drafts name no resource; unrecognized drafts are
    // rejected by the document-key check before a draft can exist.
  }
  return findings;
}

/**
 * An unselected LOGIC source draft: its recovered parse inventories literal
 * and variable-operand uses under both the candidate's and the kept baseline's
 * binding context. Syntax damage means the recovered tree cannot be trusted —
 * a half-typed call may be exactly the use being removed.
 */
function inspectSourceDraft(
  key: string,
  source: string,
  removed: readonly RemovedResource[],
  removedKeys: ReadonlySet<string>,
  input: ProjectRemovalInput,
  report: Report,
): void {
  for (const bindings of [input.authoring.bindings, input.keptBindings]) {
    let analysis: ReturnType<typeof inspectProjectSourceDependencies>;
    try {
      analysis = inspectProjectSourceDependencies({
        source,
        profile: input.profile,
        bindings,
      });
    } catch (error) {
      report(
        key,
        `draft ${key} cannot be read (${reason(error)}), so its uses cannot be inventoried.`,
      );
      return;
    }
    if (analysis.syntaxDiagnostics.length > 0) {
      report(key, `draft ${key} has syntax damage, so its uses cannot be inventoried.`);
      return;
    }
    for (const reference of analysis.references)
      if (removedKeys.has(reference.dependency))
        report(
          key,
          `${reference.dependency} is still used by draft ${key} (${reference.command}).`,
        );
    for (const unresolved of analysis.unresolved)
      for (const removedResource of removed)
        if (removedResource.kind === unresolved.kind)
          report(
            key,
            unresolved.variable === undefined
              ? `${removedResource.key} may still be used: draft ${key} reads an unresolvable ${unresolved.kind} target (${unresolved.command}).`
              : `${removedResource.key} may still be used: draft ${key} reads a ${unresolved.kind} target from v${unresolved.variable} (${unresolved.command}).`,
          );
  }
}

/** An unselected LOGIC byte draft: disassembled alone so its operands can be inventoried. */
function inspectBytecodeDraft(
  key: string,
  num: number,
  payload: Uint8Array,
  removed: readonly RemovedResource[],
  removedKeys: ReadonlySet<string>,
  profile: AgiProfile,
  report: Report,
): void {
  let inspection: ImageInspection;
  try {
    const container = openContainer(new Map(), { profile });
    container.putResource("logic", num, payload);
    inspection = inspectProjectReferences({ container, profile });
  } catch (error) {
    report(
      key,
      `draft ${key} cannot be read (${reason(error)}), so its uses cannot be inventoried.`,
    );
    return;
  }
  if (inspection.unknownDocuments.includes(key)) {
    report(key, `draft ${key} is damaged or unreadable, so its uses cannot be inventoried.`);
    return;
  }
  for (const reference of inspection.references) {
    if (reference.document !== key) continue;
    const target = reference.target;
    if ("variable" in target) {
      for (const { key: removedKey, kind } of removed)
        if (kind === target.kind)
          report(
            key,
            `${removedKey} may still be used: draft ${key} reads a ${kind} target from v${target.variable} (${reference.command}).`,
          );
      continue;
    }
    if (target.kind === "item" || target.kind === "word") continue;
    const targetKey = `${target.kind}:${target.num}`;
    if (removedKeys.has(targetKey))
      report(key, `${targetKey} is still used by draft ${key} (${reference.command}).`);
  }
}
