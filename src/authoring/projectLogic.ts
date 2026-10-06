import { assembleLogic, AssemblerError, type AssembleResult } from "../logic/assembler.ts";
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
      prelude += `#define ${name} ${binding.num}\n`;
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
    return {
      assembly: assembleLogic(prelude + source, {
        dictionary: context.dictionary,
        profile: context.profile,
        sourceMap: context.sourceMap === true,
      }),
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
