/**
 * Automatic binding-ID allocation against a project snapshot. Occupied numbers
 * come from three places: the container's indexed resources, the existing
 * binding records, and — for flags and variables — the operands every compiled
 * logic actually uses. Pure and provider-independent: it reads a structural
 * context and returns fresh numbers; nothing here mutates the container or
 * the bindings record, and a failed call reserves nothing.
 */
import { disassembleLogic } from "../logic/disassembler.ts";
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
function occupiedIds(context: AllocationContext, kind: AllocationKind): Set<number> {
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
    return used;
  }
  for (let num = 0; num < 256; num++) {
    const payload = context.container.getResource("logic", num);
    if (!payload) continue;
    const source = disassembleLogic(payload, {
      profile: context.profile,
      dictionary: context.dictionary,
    });
    if (
      source.includes("// !!") ||
      /\b(?:lindirectv|rindirect|lindirectn|set\.v|reset\.v|toggle\.v|isset\.v)\s*\(/.test(source)
    )
      throw new Error(
        `Logic ${num} has indirect or undecodable state access. Read its logic and bind an explicit ID; automatic allocation cannot establish a free ${kind}.`,
      );
    // Remove literals/comments: a message saying 'f32' is not an operand.
    const code = source.replace(/\/\/[^\n]*|"(?:\\[^\n]|[^"\\\n])*"/g, "");
    for (const match of code.matchAll(kind === "flag" ? /\bf(\d+)\b/g : /\bv(\d+)\b/g))
      used.add(Number(match[1]));
  }
  return used;
}

/**
 * Reserve `count` fresh numbers for `kind`, ascending from the lowest free
 * slot: 1 for resources, 32 for flags and variables, whose lower slots are
 * interpreter state. Numbers already bound or used by compiled logic stay
 * occupied; a logic whose state access cannot be proven static — indirect
 * operands or bytecode the disassembler cannot reconstruct — refuses the
 * whole allocation rather than guess. The batch is atomic: either `count`
 * distinct numbers come back, or an error and nothing is reserved.
 */
export function allocateProjectIds(
  context: AllocationContext,
  kind: AllocationKind,
  count = 1,
): readonly number[] {
  if (
    kind !== "flag" &&
    kind !== "variable" &&
    !(RESOURCE_KINDS as readonly string[]).includes(kind)
  )
    throw new Error(`Invalid allocation kind '${String(kind)}'.`);
  if (!Number.isInteger(count) || count < 1 || count > 256)
    throw new RangeError("count must be an integer in 1..256.");
  const used = occupiedIds(context, kind);
  const start = kind === "flag" || kind === "variable" ? 32 : 1;
  const ids: number[] = [];
  for (let candidate = start; candidate < 256 && ids.length < count; candidate++) {
    if (used.has(candidate)) continue;
    used.add(candidate);
    ids.push(candidate);
  }
  if (ids.length < count) throw new Error(`No free ${kind} IDs remain.`);
  return ids;
}
