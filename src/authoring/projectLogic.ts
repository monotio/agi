import { assembleLogic, AssemblerError, type AssembleResult } from "../logic/assembler.ts";
import { systemBindings } from "../logic/systemNames.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { analyzeLogicSyntax, scanLogicTokens } from "../logic/syntax.ts";

interface ProjectLogicContext {
  readonly profile: AgiProfile;
  readonly dictionary: ReadonlyMap<string, number>;
  readonly bindings: Readonly<
    Record<string, { readonly num: number; readonly kind?: string; readonly logic?: number }>
  >;
  readonly sourceMap?: boolean;
}

interface ProjectLogicBuild {
  /** Map and diagnostic offsets address the exact expanded compiler input. */
  readonly assembly: AssembleResult;
  readonly expansion: {
    readonly authored: string;
    readonly prelude: string;
    /** UTF-16 offset at which authored text begins in the expanded source. */
    readonly authoredStart: number;
  };
}

/** One binding expansion for strict builds and recoverable editor analysis. */
export function expandProjectLogic(
  source: string,
  bindings: ProjectLogicContext["bindings"],
  recover = false,
) {
  const tokens = recover ? analyzeLogicSyntax(source).tokens : scanLogicTokens(source);
  const defined = new Set(
    tokens.flatMap((token, index) =>
      token.type === "directive" && token.text === "#define" && tokens[index + 1]?.type === "ident"
        ? [tokens[index + 1]!.text]
        : [],
    ),
  );
  let prelude = "";
  const generated = Object.entries(bindings)
    .filter(([name]) => !defined.has(name))
    .map(([name, binding]) => {
      const start = prelude.length;
      const prefix = binding.kind === "flag" ? "f" : binding.kind === "variable" ? "v" : "";
      prelude += `#define ${name} ${prefix}${binding.num}\n`;
      return { name, start, end: prelude.length };
    });
  return { authored: source, prelude, authoredStart: prelude.length, generated };
}

/** Shared by manual authoring and agent adapters; no session or provider is needed. */
export function compileProjectLogic(
  source: string,
  context: ProjectLogicContext,
): ProjectLogicBuild {
  const expansion = expandProjectLogic(source, context.bindings);
  const { prelude, generated } = expansion;
  try {
    const assembly = assembleLogic(prelude + source, {
      builtins: systemBindings(context.bindings),
      dictionary: context.dictionary,
      profile: context.profile,
      sourceMap: context.sourceMap === true,
    });
    return {
      assembly: {
        ...assembly,
        diagnostics: [
          ...assembly.diagnostics,
          ...projectNameDiagnostics(source, context.bindings).map((entry) => ({
            ...entry,
            start: entry.start + expansion.authoredStart,
            end: entry.end + expansion.authoredStart,
            line: entry.line + generated.length,
          })),
        ],
      },
      expansion,
    };
  } catch (error) {
    // Preserve prelude diagnostics as generated-source errors; only authored
    // lines can be translated back into the document the caller is editing.
    if (!(error instanceof AssemblerError) || error.line <= generated.length) throw error;
    const detail = error.message.slice(`${error.line}:${error.col}: `.length);
    throw new AssemblerError(detail, error.line - generated.length, error.col);
  }
}

/** Shadowing is permitted; the warning identifies both meanings at the use. */
export function projectNameDiagnostics(source: string, bindings: ProjectLogicContext["bindings"]) {
  const defaults = systemBindings();
  const syntax = analyzeLogicSyntax(source, systemBindings(bindings));
  return syntax.references.flatMap((reference) => {
    if (!Object.hasOwn(bindings, reference.name) || !Object.hasOwn(defaults, reference.name))
      return [];
    const binding = bindings[reference.name];
    const builtin = defaults[reference.name];
    if (
      !binding ||
      !builtin ||
      reference.definitionStart !== undefined ||
      (binding.num === builtin.num &&
        (binding.kind === undefined ||
          binding.kind === (builtin.kind === "v" ? "variable" : "flag")))
    )
      return [];
    const token = syntax.tokens.find((entry) => entry.start === reference.start)!;
    const kind =
      binding.kind === "flag"
        ? "Flag"
        : binding.kind === "variable" || binding.kind === undefined
          ? "Variable"
          : binding.kind.toUpperCase();
    return [
      {
        code: "builtin-shadow" as const,
        message: `'${reference.name}' names ${kind} ${binding.num} in this project and shadows built-in ${builtin.kind === "v" ? "Variable" : "Flag"} ${builtin.num}.`,
        start: token.start,
        end: token.end,
        line: token.line,
        col: token.col,
      },
    ];
  });
}
