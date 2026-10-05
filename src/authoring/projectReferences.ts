/**
 * Native project reference inventory shared by editor and agent clients.
 * Literal operands are definite references, including uses in unreachable code;
 * variable operands remain explicitly unresolved. This is not a reachability or
 * whole-program data-flow proof. Source drafts, world plans and stored tests must
 * contribute their own references before a caller authorizes removal.
 */
import { inspectLogicResource } from "../logic/disassembler.ts";
import { actionSpec, conditionSpec, SAID_ANY_WORD, SAID_REST } from "../logic/opcodes.ts";
import { parseWordsTok } from "../logic/words.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { RESOURCE_KINDS, type GameContainer, type ResourceKind } from "../types.ts";
import { readInventoryObjects } from "./inventory.ts";

type TargetKind = ResourceKind | "item" | "word";
type Target =
  | { readonly kind: TargetKind; readonly num: number }
  | { readonly kind: TargetKind; readonly variable: number };
interface Reference {
  readonly document: string;
  /** Code-section byte offset; omitted for auxiliary documents. */
  readonly pc?: number;
  readonly command: string;
  readonly target: Target;
}
interface Diagnostic {
  readonly document: string;
  readonly pc?: number;
  readonly command?: string;
  readonly code:
    | "missing-resource"
    | "missing-item"
    | "missing-word"
    | "unresolved-reference"
    | "incomplete-logic"
    | "unreadable-document";
  readonly severity: "error" | "warning";
  readonly message: string;
}
interface ResourceOperand {
  readonly kind: ResourceKind | "item";
  readonly operand: number;
  readonly variable?: true;
}

// Names are resolved through the selected profile's decoder before this table
// is consulted. These describe the referenced family, not opcode execution.
const RESOURCE_REFERENCE_OPERANDS: Readonly<Record<string, ResourceOperand>> = {
  "new.room": { kind: "logic", operand: 0 },
  "new.room.v": { kind: "logic", operand: 0, variable: true },
  "load.logics": { kind: "logic", operand: 0 },
  "load.logics.v": { kind: "logic", operand: 0, variable: true },
  call: { kind: "logic", operand: 0 },
  "call.v": { kind: "logic", operand: 0, variable: true },
  "trace.info": { kind: "logic", operand: 0 },
  "load.pic": { kind: "picture", operand: 0, variable: true },
  "draw.pic": { kind: "picture", operand: 0, variable: true },
  "discard.pic": { kind: "picture", operand: 0, variable: true },
  "overlay.pic": { kind: "picture", operand: 0, variable: true },
  "load.view": { kind: "view", operand: 0 },
  "load.view.v": { kind: "view", operand: 0, variable: true },
  "discard.view": { kind: "view", operand: 0 },
  "discard.view.v": { kind: "view", operand: 0, variable: true },
  "set.view": { kind: "view", operand: 1 },
  "set.view.v": { kind: "view", operand: 1, variable: true },
  "add.to.pic": { kind: "view", operand: 0 },
  "add.to.pic.v": { kind: "view", operand: 0, variable: true },
  "show.obj": { kind: "view", operand: 0 },
  "show.obj.v": { kind: "view", operand: 0, variable: true },
  "load.sound": { kind: "sound", operand: 0 },
  sound: { kind: "sound", operand: 0 },
  "get.v": { kind: "item", operand: 0, variable: true },
  "put.v": { kind: "item", operand: 0, variable: true },
  "get.room.v": { kind: "item", operand: 0, variable: true },
};

/** Sound discard is a real resource use only on IIgs; see fidelity.md "Apple IIgs sound discard". */
export function resourceReferenceOperand(
  command: string,
  profile: AgiProfile,
): ResourceOperand | undefined {
  if (command === "discard.sound")
    return profile.extraActions === "iigs" ? { kind: "sound", operand: 0 } : undefined;
  return RESOURCE_REFERENCE_OPERANDS[command];
}

export function inspectProjectReferences(input: {
  readonly container: GameContainer;
  readonly profile: AgiProfile;
  readonly bindings?: Readonly<Record<string, { readonly kind: string; readonly num: number }>>;
  /** Agent-enabled missing-room creation is an explicit caller policy. */
  readonly allowMissingRooms?: boolean;
}): {
  readonly references: readonly Reference[];
  readonly diagnostics: readonly Diagnostic[];
  /** Definite document dependencies; unresolved resource targets add no invented IDs. */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  /** Damaged inputs prevent a complete inventory of their uses. */
  readonly unknownDocuments: readonly string[];
} {
  const { container, profile } = input;
  const references: Reference[] = [];
  const diagnostics: Diagnostic[] = [];
  const unknown = new Set<string>();
  const dependencies: Record<string, Set<string>> = Object.create(null);
  const unreadable = (document: string, error: unknown): void => {
    unknown.add(document);
    diagnostics.push({
      document,
      code: "unreadable-document",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const add = (reference: Reference): void => {
    references.push(reference);
    const target = reference.target;
    const dependency =
      target.kind === "item"
        ? "inventory"
        : target.kind === "word"
          ? "words"
          : "num" in target
            ? `${target.kind}:${target.num}`
            : undefined;
    if (dependency !== undefined) (dependencies[reference.document] ??= new Set()).add(dependency);
  };
  const dictionary = new Map<string, number>();
  let wordIds: Set<number> | undefined;
  try {
    const payload = container.files.get("WORDS.TOK");
    for (const entry of payload ? parseWordsTok(payload) : []) dictionary.set(entry.word, entry.id);
    wordIds = new Set(dictionary.values());
  } catch (error) {
    unreadable("words", error);
  }
  let inventoryCount: number | undefined;
  try {
    inventoryCount = readInventoryObjects(container.files.get("OBJECT"), profile).length;
  } catch (error) {
    unreadable("inventory", error);
  }
  for (let num = 0; num < 256; num++) {
    const document = `logic:${num}`;
    try {
      const payload = container.getResource("logic", num);
      if (!payload) continue;
      const decoded = inspectLogicResource(payload, { profile, dictionary });
      for (const message of decoded.warnings) {
        unknown.add(document);
        diagnostics.push({ document, code: "incomplete-logic", severity: "error", message });
      }
      const calls = [
        ...decoded.instructions
          .filter((instruction) => instruction.kind === "action")
          .map((instruction) => ({
            at: instruction.at,
            name: instruction.name!,
            args: instruction.args!,
            operands: actionSpec(instruction.name!, profile)!.operands,
          })),
        ...decoded.predicates.map((predicate) => ({
          ...predicate,
          operands: conditionSpec(predicate.name)!.operands,
        })),
      ].sort((left, right) => left.at - right.at);
      for (const call of calls) {
        const origin = { document, pc: call.at, command: call.name };
        const resource = resourceReferenceOperand(call.name, profile);
        if (resource) {
          const value = call.args[resource.operand]!;
          add({
            ...origin,
            target: resource.variable
              ? { kind: resource.kind, variable: value }
              : { kind: resource.kind, num: value },
          });
        }
        call.operands.forEach((operand, index) => {
          if (operand === "item")
            add({ ...origin, target: { kind: "item", num: call.args[index]! } });
        });
        if (call.name === "said")
          for (const id of call.args)
            if (id !== SAID_ANY_WORD && id !== SAID_REST)
              add({ ...origin, target: { kind: "word", num: id } });
      }
    } catch (error) {
      unreadable(document, error);
    }
  }
  for (const [name, binding] of Object.entries(input.bindings ?? {}))
    if ((RESOURCE_KINDS as readonly string[]).includes(binding.kind))
      add({
        document: "bindings",
        command: name,
        target: { kind: binding.kind as ResourceKind, num: binding.num },
      });

  for (const reference of references) {
    const { target, ...origin } = reference;
    if ("variable" in target) {
      diagnostics.push({
        ...origin,
        code: "unresolved-reference",
        severity: "warning",
        message: `${reference.command} reads its ${target.kind} target from v${target.variable}; the target is unresolved.`,
      });
      continue;
    }
    if (target.kind === "word") {
      if (wordIds !== undefined && !wordIds.has(target.num))
        diagnostics.push({
          ...origin,
          code: "missing-word",
          severity: "error",
          message: `Word group ${target.num} has no dictionary entry.`,
        });
    } else if (target.kind === "item") {
      if (inventoryCount !== undefined && target.num >= inventoryCount)
        diagnostics.push({
          ...origin,
          code: "missing-item",
          severity: "error",
          message: `Inventory item ${target.num} is absent.`,
        });
    } else {
      try {
        if (!container.getResource(target.kind, target.num))
          diagnostics.push({
            ...origin,
            code: "missing-resource",
            severity:
              reference.document === "bindings" ||
              (input.allowMissingRooms && reference.command === "new.room")
                ? "warning"
                : "error",
            message: `${target.kind.toUpperCase()} ${target.num} is absent.`,
          });
      } catch (error) {
        unreadable(`${target.kind}:${target.num}`, error);
      }
    }
  }
  return {
    references,
    diagnostics,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([key, values]) => [key, [...values].sort()]),
    ),
    unknownDocuments: [...unknown].sort(),
  };
}
