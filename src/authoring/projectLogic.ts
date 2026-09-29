import { assembleLogic, AssemblerError, type AssembleResult } from "../logic/assembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { scanLogicTokens } from "../logic/syntax.ts";

interface ProjectLogicContext {
  readonly profile: AgiProfile;
  readonly dictionary: ReadonlyMap<string, number>;
  readonly bindings: Readonly<Record<string, { readonly num: number }>>;
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

/** Shared by manual authoring and agent adapters; no session or provider is needed. */
export function compileProjectLogic(
  source: string,
  context: ProjectLogicContext,
): ProjectLogicBuild {
  const tokens = scanLogicTokens(source);
  const defined = new Set(
    tokens.flatMap((token, index) =>
      token.type === "directive" && token.text === "#define" && tokens[index + 1]?.type === "ident"
        ? [tokens[index + 1]!.text]
        : [],
    ),
  );
  const lines = Object.entries(context.bindings)
    .filter(([name]) => !defined.has(name))
    .map(([name, binding]) => `#define ${name} ${binding.num}`);
  const prelude = lines.length ? `${lines.join("\n")}\n` : "";
  try {
    return {
      assembly: assembleLogic(prelude + source, {
        dictionary: context.dictionary,
        profile: context.profile,
        sourceMap: context.sourceMap === true,
      }),
      expansion: { authored: source, prelude, authoredStart: prelude.length },
    };
  } catch (error) {
    // Preserve prelude diagnostics as generated-source errors; only authored
    // lines can be translated back into the document the caller is editing.
    if (!(error instanceof AssemblerError) || error.line <= lines.length) throw error;
    const detail = error.message.slice(`${error.line}:${error.col}: `.length);
    throw new AssemblerError(detail, error.line - lines.length, error.col);
  }
}
