/**
 * Automatic binding-ID allocation against a project snapshot. Occupied numbers
 * come from three places: the container's indexed resources, the existing
 * binding records, and — for flags and variables — the operands every compiled
 * logic actually uses, plus formatted message/view/inventory text. Pure and provider-independent: it reads a structural
 * context and returns fresh numbers; nothing here mutates the container or
 * the bindings record, and a failed call reserves nothing.
 */
import { inspectLogicResource } from "../logic/disassembler.ts";
import { actionSpec, CONDITION_BY_NAME } from "../logic/opcodes.ts";
import { parseView } from "../view/view.ts";
import { readInventoryObjects } from "./inventory.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { RESOURCE_KINDS, type GameContainer, type ResourceKind } from "../types.ts";

/** The families automatic allocation can number. */
export type AllocationKind = ResourceKind | "flag" | "variable";

/**
 * The project slice allocation reads. Structural, not a session: any holder
 * of a container, its interpreter profile, its word dictionary and its
 * binding records can call.
 */
export interface AllocationContext {
  readonly container: GameContainer;
  readonly profile: AgiProfile;
  /** The same lowercase word -> id map logic disassembly renders said() against. */
  readonly dictionary: ReadonlyMap<string, number>;
  readonly bindings: Readonly<
    Record<string, { readonly kind: AllocationKind; readonly num: number }>
  >;
}

/** Discover static operands; refuse automatic allocation where runtime indirection obscures usage. */
function occupiedIds(
  context: AllocationContext,
  kind: AllocationKind,
  warnings: Set<string>,
): Set<number> {
  const used = new Set<number>();
  for (const binding of Object.values(context.bindings)) {
    if (binding.kind === kind) used.add(binding.num);
  }
  if (kind !== "flag" && kind !== "variable") {
    for (let num = 0; num < 256; num++) {
      try {
        if (context.container.getResource(kind, num)) used.add(num);
      } catch {
        // A damaged indexed resource stays occupied: its slot is not reusable.
        used.add(num);
      }
    }
    const analysis = inspectProjectReferences(context);
    for (const reference of analysis.references) {
      if (reference.target.kind !== kind) continue;
      if ("num" in reference.target) used.add(reference.target.num);
      else
        warnings.add(
          `${reference.document} has an unresolved ${kind} target from v${reference.target.variable}. Allocated IDs avoid known stored references.`,
        );
    }
    if (analysis.unknownDocuments.length)
      warnings.add(
        `References in ${analysis.unknownDocuments.join(", ")} could not be completely inspected. Allocated IDs avoid known stored references.`,
      );
    return used;
  }
  for (let num = 0; num < 256; num++) {
    const payload = context.container.getResource("logic", num);
    if (!payload) continue;
    const decoded = inspectLogicResource(payload, {
      profile: context.profile,
      dictionary: context.dictionary,
    });
    const calls = [
      ...decoded.instructions
        .filter((instruction) => instruction.kind === "action")
        .map((instruction) => ({
          name: instruction.name!,
          args: instruction.args!,
          operands: actionSpec(instruction.name!, context.profile)!.operands,
        })),
      ...decoded.predicates.map((predicate) => ({
        ...predicate,
        operands: CONDITION_BY_NAME[predicate.name]!.operands,
      })),
    ];
    if (
      decoded.warnings.length > 0 ||
      calls.some(({ name }) =>
        [
          "lindirectv",
          "rindirect",
          "lindirectn",
          "set.v",
          "reset.v",
          "toggle.v",
          "isset.v",
        ].includes(name),
      )
    )
      throw new Error(
        `Logic ${num} has indirect or undecodable state access. Read its logic and bind an explicit ID; automatic allocation cannot establish a free ${kind}.`,
      );
    for (const call of calls) {
      call.operands.forEach((operand, index) => {
        if (operand === (kind === "flag" ? "flag" : "var")) used.add(call.args[index]!);
      });
    }
    if (kind === "variable")
      for (const message of decoded.messages)
        reserveFormattedVariables(message ?? "", used, warnings);
  }
  if (kind === "variable") {
    for (let num = 0; num < 256; num++) {
      const payload = context.container.getResource("view", num);
      if (payload)
        reserveFormattedVariables(
          parseView(payload, context.profile).description ?? "",
          used,
          warnings,
        );
    }
    for (const item of readInventoryObjects(context.container.files.get("OBJECT"), context.profile))
      reserveFormattedVariables(item.name, used, warnings);
  }
  return used;
}

/** Mirrors formatter token consumption; %o reads a variable holding an item ID. */
function reserveFormattedVariables(text: string, used: Set<number>, warnings: Set<string>): void {
  for (let at = 0; at < text.length;) {
    if (text[at++] !== "%") continue;
    const code = text[at++] ?? "";
    if (!"vsmgow".includes(code) || code === "") continue;
    let number = 0;
    while (at < text.length && text.charCodeAt(at) >= 48 && text.charCodeAt(at) <= 57)
      number = number * 10 + text.charCodeAt(at++) - 48;
    if ((code === "v" || code === "o") && number <= 255) used.add(number);
    // Runtime strings/parsed words are recursively formatted. Their contents
    // can name variables that no stored operand or message reveals.
    if (code === "s" || code === "w")
      warnings.add(
        "Runtime formatted text can read additional variables. Allocated IDs avoid known stored references; runtime text reads remain unknown.",
      );
  }
}

/**
 * Reserve `count` fresh numbers for `kind`, ascending from the lowest free
 * slot: 1 for resources, 32 for flags and variables, whose lower slots are
 * interpreter state. Numbers already bound or used by compiled logic stay
 * occupied; a logic whose state access cannot be proven static — indirect
 * operands or bytecode the disassembler cannot reconstruct — refuses the
 * whole allocation rather than guess. Runtime text reads are reported as warnings,
 * since player input can mention any variable. The batch is atomic: either `count`
 * distinct numbers come back, or an error and nothing is reserved.
 */
export function allocateProjectIds(
  context: AllocationContext,
  kind: AllocationKind,
  count = 1,
): { readonly ids: readonly number[]; readonly warnings: readonly string[] } {
  if (
    kind !== "flag" &&
    kind !== "variable" &&
    !(RESOURCE_KINDS as readonly string[]).includes(kind)
  )
    throw new Error(`Invalid allocation kind '${String(kind)}'.`);
  if (!Number.isInteger(count) || count < 1 || count > 256)
    throw new RangeError("count must be an integer in 1..256.");
  const warnings = new Set<string>();
  const used = occupiedIds(context, kind, warnings);
  const start = kind === "flag" || kind === "variable" ? 32 : 1;
  const ids: number[] = [];
  for (let candidate = start; candidate < 256 && ids.length < count; candidate++) {
    if (used.has(candidate)) continue;
    used.add(candidate);
    ids.push(candidate);
  }
  if (ids.length < count) throw new Error(`No free ${kind} IDs remain.`);
  return { ids, warnings: [...warnings] };
}
