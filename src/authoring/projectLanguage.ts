/** Project-aware language operations retain authored ranges and binding ownership. */
import { createLogicLanguageSnapshot } from "../logic/language.ts";
import { expandProjectLogic } from "./projectLogic.ts";

export function createProjectLogicLanguageSnapshot(
  input: Parameters<typeof createLogicLanguageSnapshot>[0] & {
    readonly bindings: Parameters<typeof expandProjectLogic>[1];
  },
) {
  const source = input.source;
  const expansion = expandProjectLogic(source, input.bindings, true);
  const base = expansion.authoredStart;
  const language = createLogicLanguageSnapshot({
    source: expansion.prelude + source,
    profile: input.profile,
    dictionary: input.dictionary,
  });
  const diagnostics = language.diagnostics
    .filter((entry) => entry.start >= base)
    .map((entry) => {
      const line = entry.line - expansion.generated.length;
      const prefix = `${entry.line}:${entry.col}: `;
      return Object.freeze({
        ...entry,
        line,
        start: entry.start - base,
        end: entry.end - base,
        message: entry.message.startsWith(prefix)
          ? `${line}:${entry.col}: ${entry.message.slice(prefix.length)}`
          : entry.message,
      });
    });
  const generatedDiagnostics = language.diagnostics
    .filter((entry) => entry.start < base)
    .map((entry) =>
      Object.freeze({
        binding:
          expansion.generated.find(
            (binding) => binding.start <= entry.start && binding.end > entry.start,
          )?.name ?? null,
        message: entry.message,
        severity: entry.severity,
      }),
    );

  function expandedOffset(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
      throw new RangeError(
        "Cursor offset must be within the authored source in UTF-16 code units.",
      );
    return base + offset;
  }

  function authoredRange<T extends { readonly start: number; readonly end: number }>(range: T): T {
    if (range.start < base || range.end > base + source.length)
      throw new Error("A generated source range cannot be edited as authored text.");
    return { ...range, start: range.start - base, end: range.end - base };
  }

  function completeAt(offset: number) {
    return language.completeAt(expandedOffset(offset)).map(authoredRange);
  }

  function signatureAt(offset: number) {
    return language.signatureAt(expandedOffset(offset));
  }

  function hoverAt(offset: number) {
    const hover = language.hoverAt(expandedOffset(offset));
    return hover ? authoredRange(hover) : null;
  }

  function definitionAt(offset: number) {
    const definition = language.definitionAt(expandedOffset(offset));
    if (!definition) return null;
    if (definition.start >= base) return authoredRange(definition);
    return { kind: "binding" as const, name: definition.name, document: "bindings" as const };
  }

  /** Authored uses only; a binding's definition belongs to the bindings document. */
  function referencesAt(offset: number) {
    return language
      .referencesAt(expandedOffset(offset))
      .filter((range) => range.start >= base)
      .map(authoredRange);
  }

  function renameAt(offset: number, name: string) {
    if (definitionAt(offset)?.kind === "binding")
      throw new Error("A binding needs a coordinated project rename across all of its documents.");
    return language.renameAt(expandedOffset(offset), name).map(authoredRange);
  }

  return {
    source,
    diagnostics: Object.freeze(diagnostics),
    generatedDiagnostics: Object.freeze(generatedDiagnostics),
    completeAt,
    signatureAt,
    hoverAt,
    definitionAt,
    referencesAt,
    renameAt,
  };
}
