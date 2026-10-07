/** One presentation contract for numbered game identities in tools and the app. */
import { systemName } from "./systemNames.ts";

export interface NumberedLabelContext {
  readonly bindings?: Readonly<
    Record<string, { readonly kind?: string; readonly num: number; readonly logic?: number }>
  >;
  readonly names?: Readonly<Record<string, string>>;
  readonly inventory?: readonly (string | { readonly name: string; readonly num?: number })[];
  readonly rooms?: readonly { readonly room: number; readonly title?: string | undefined }[];
  readonly words?: readonly (readonly [string, number])[];
  readonly logic?: number;
  /** A resolved local definition, where the host already knows its scope. */
  readonly name?: string;
}
const KINDS: Record<string, string> = {
  f: "flag",
  v: "variable",
  var: "variable",
  o: "object",
  i: "inventory",
  item: "inventory",
  w: "word",
  s: "string",
  m: "message",
  c: "controller",
};
const TITLES: Record<string, string> = {
  flag: "Flag",
  variable: "Variable",
  object: "Object",
  inventory: "Item",
  room: "Room",
  word: "Word group",
  string: "String",
  message: "Message",
  controller: "Controller",
  logic: "LOGIC",
  picture: "PICTURE",
  view: "VIEW",
  sound: "SOUND",
};
export function numberedKindTitle(kind: string): string {
  const canonical = KINDS[kind] ?? kind;
  return TITLES[canonical] ?? canonical;
}
export function numberedSlot(kind: string, num: number): string {
  return `${numberedKindTitle(kind)} ${num}`;
}
export function numberedLabel(
  kind: string,
  num: number,
  context: NumberedLabelContext = {},
  format: "inline" | "option" | "row" = "inline",
): string {
  const canonical = KINDS[kind] ?? kind;
  const binding = Object.entries(context.bindings ?? {})
    .filter(
      ([, value]) =>
        (KINDS[value.kind ?? ""] ?? value.kind) === canonical &&
        value.num === num &&
        (value.logic === undefined || value.logic === context.logic),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0]?.[0];
  const item = context.inventory?.find(
    (entry, index) => (typeof entry === "string" ? index : (entry.num ?? index)) === num,
  );
  const supplied =
    canonical === "inventory"
      ? typeof item === "string"
        ? item
        : item?.name
      : canonical === "room"
        ? context.rooms?.find((room) => room.room === num)?.title
        : canonical === "word"
          ? context.words
              ?.filter(([, id]) => id === num)
              .map(([word]) => word)
              .sort()
              .join(", ")
          : undefined;
  const name =
    binding ||
    context.name ||
    context.names?.[`${canonical}:${num}`] ||
    supplied ||
    systemName(canonical, num);
  const slot = numberedSlot(canonical, num);
  if (!name || name === slot) return slot;
  return format === "option" ? `${name} (${slot})` : format === "row" ? `${name} · ${slot}` : name;
}

/** Non-numbered documents keep their own titles. */
export function documentLabel(
  key: string,
  context: NumberedLabelContext = {},
  format: "inline" | "option" | "row" = "row",
): string {
  const match = /^(\w+):(\d+)$/.exec(key);
  if (match) return numberedLabel(match[1]!, Number(match[2]), context, format);
  const titles: Record<string, string> = {
    inventory: "Objects",
    words: "Words",
    bindings: "Game state",
    world: "World",
    notes: "Notes",
    tests: "Tests",
    references: "References",
    images: "Images",
    music: "Music",
  };
  return titles[key] ?? key;
}

/** A watch may be a single numbered identity or a compound source expression. */
export function numberedExpressionLabel(
  expression: string,
  context: NumberedLabelContext = {},
): string {
  const match = /^([vfoismcw])(0|[1-9]\d*)$/.exec(expression.trim());
  return match ? numberedLabel(match[1]!, Number(match[2]), context, "option") : expression;
}

/** Picker identities stay numeric even when their names change. */
export function numberedOptions(
  kind: string,
  numbers: readonly number[],
  context: NumberedLabelContext = {},
): { num: number; label: string }[] {
  return [...numbers]
    .sort((a, b) => a - b)
    .map((num) => ({ num, label: numberedLabel(kind, num, context, "option") }));
}
