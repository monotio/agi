/** Project-aware language operations retain authored ranges and binding ownership. */
import { createLogicLanguageSnapshot } from "../logic/language.ts";
import { analyzeLogicSyntax } from "../logic/syntax.ts";
import type { NumberedOperand } from "../logic/languageOperands.ts";
import { systemBindings } from "../logic/systemNames.ts";
import { expandProjectLogic, projectNameDiagnostics } from "./projectLogic.ts";

export function createProjectLogicLanguageSnapshot(
  input: Parameters<typeof createLogicLanguageSnapshot>[0] & {
    readonly bindings: Parameters<typeof expandProjectLogic>[1];
  },
) {
  const source = input.source;
  const builtins = systemBindings(input.bindings);
  const expansion = expandProjectLogic(source, input.bindings, true);
  const base = expansion.authoredStart;
  const language = createLogicLanguageSnapshot({
    source: expansion.prelude + source,
    builtins,
    profile: input.profile,
    dictionary: input.dictionary,
    bindings: Object.fromEntries(
      expansion.generated.map(({ name }) => [name, input.bindings[name]!]),
    ),
    ...(input.objects ? { objects: input.objects } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.logic !== undefined ? { logic: input.logic } : {}),
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
  diagnostics.push(
    ...projectNameDiagnostics(source, input.bindings).map((entry) => ({
      ...entry,
      severity: "warning" as const,
    })),
  );
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

  const operands: readonly (NumberedOperand & { readonly bindingName?: string })[] =
    language.operands
      .filter((entry) => entry.start >= base)
      .map((entry) => {
        const { definitionStart, ...range } = entry;
        return {
          ...authoredRange(range),
          ...(definitionStart === undefined
            ? entry.name && builtins[entry.name]
              ? { bindingName: entry.name }
              : {}
            : definitionStart < base
              ? entry.name
                ? { bindingName: entry.name }
                : {}
              : { definitionStart: definitionStart - base }),
        };
      });
  const resourceNames: (NumberedOperand & { readonly bindingName?: string })[] = [];
  for (const reference of analyzeLogicSyntax(source).references) {
    const binding = input.bindings[reference.name];
    if (
      binding &&
      ["logic", "picture", "view", "sound"].includes(binding.kind ?? "") &&
      definitionAt(reference.start)?.kind === "binding" &&
      !operands.some((operand) => operand.start === reference.start)
    )
      resourceNames.push({
        kind: binding.kind as NumberedOperand["kind"],
        num: binding.num,
        start: reference.start,
        end: reference.end,
        declaration: false,
        name: reference.name,
        bindingName: reference.name,
      });
  }

  function operandAt(offset: number) {
    expandedOffset(offset);
    return [...operands, ...resourceNames].find(
      (entry) => entry.start <= offset && entry.end > offset,
    );
  }

  function definitionAt(offset: number) {
    const definition = language.definitionAt(expandedOffset(offset));
    if (!definition) {
      const operand = language.operandAt(expandedOffset(offset));
      return operand?.name && builtins[operand.name]
        ? { kind: "binding" as const, name: operand.name, document: "bindings" as const }
        : null;
    }
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
    if (operandAt(offset) && !operandAt(offset)?.name)
      throw new Error(
        "Numbered operands have fixed identities. Rename a named binding or #define instead.",
      );
    if (definitionAt(offset)?.kind === "binding")
      throw new Error("A binding needs a coordinated project rename across all of its documents.");
    return language.renameAt(expandedOffset(offset), name).map(authoredRange);
  }

  function quickFixes() {
    const fixes: {
      title: string;
      diagnostic: (typeof diagnostics)[number];
      edits: { start: number; end: number; text: string }[];
    }[] = [];
    const tokens = analyzeLogicSyntax(source).tokens;
    for (const diagnostic of diagnostics) {
      const unknown = /unknown identifier '([a-zA-Z_.][a-zA-Z0-9_.]*)'/.exec(diagnostic.message);
      if (unknown && !Object.hasOwn(input.bindings, unknown[1]!))
        fixes.push({
          title: `Define ${unknown[1]} as 0`,
          diagnostic,
          edits: [{ start: 0, end: 0, text: `#define ${unknown[1]} 0\n` }],
        });
      if (/expected ;/.test(diagnostic.message)) {
        const previous = tokens
          .filter((token) => token.end <= diagnostic.start && token.type !== "eof")
          .at(-1);
        if (previous) {
          const changed = source.slice(0, previous.end) + ";" + source.slice(previous.end);
          const result = createProjectLogicLanguageSnapshot({ ...input, source: changed });
          if (result.diagnostics.length < diagnostics.length)
            fixes.push({
              title: "Insert semicolon",
              diagnostic,
              edits: [{ start: previous.end, end: previous.end, text: ";" }],
            });
        }
      }
    }
    return fixes;
  }

  return {
    source,
    operands: [...operands, ...resourceNames].sort((a, b) => a.start - b.start),
    operandAt,
    diagnostics: Object.freeze(diagnostics),
    generatedDiagnostics: Object.freeze(generatedDiagnostics),
    completeAt,
    signatureAt,
    hoverAt,
    definitionAt,
    referencesAt,
    renameAt,
    quickFixes,
  };
}
