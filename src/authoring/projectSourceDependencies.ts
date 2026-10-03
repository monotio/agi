/**
 * Dependencies for selecting source drafts before strict project compilation.
 * Uses the compiler's recoverable syntax and the native reference inventory's
 * operand roles. A recovered tree is never evidence that removal is safe: the
 * final selected image still needs strict compilation and reference admission.
 */
import { actionSpec, CONDITION_BY_NAME } from "../logic/opcodes.ts";
import { analyzeLogicSyntax, type Ref, type Stmt, type TestExpr } from "../logic/syntax.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { expandProjectLogic } from "./projectLogic.ts";
import { resourceReferenceOperand } from "./projectReferences.ts";

interface SourceReference {
  /** Authored UTF-16 call offset; never a generated binding location. */
  readonly start: number;
  readonly command: string;
  readonly dependency: string;
}
interface UnresolvedReference {
  readonly start: number;
  readonly command: string;
  readonly kind: string;
  /** Omitted when the operand itself is incomplete or invalid. */
  readonly variable?: number;
}

export function inspectProjectSourceDependencies(input: {
  readonly source: string;
  readonly profile: AgiProfile;
  readonly bindings: Parameters<typeof expandProjectLogic>[1];
}) {
  const expansion = expandProjectLogic(input.source, input.bindings, true);
  const syntax = analyzeLogicSyntax(expansion.prelude + input.source);
  const base = expansion.authoredStart;
  const dependencies = new Set<string>();
  const bindings = new Set<string>();
  const references: SourceReference[] = [];
  const unresolved: UnresolvedReference[] = [];
  // Unresolved names also require the bindings draft: it may define a name
  // which does not exist in the kept context. Strict compilation checks typos.
  for (const reference of syntax.references) {
    if (
      reference.start >= base &&
      reference.kind === "define" &&
      (reference.definitionStart === undefined || reference.definitionStart < base)
    ) {
      bindings.add(reference.name);
      dependencies.add("bindings");
    }
  }

  function inspectCall(
    call: { readonly name: string; readonly args: readonly Ref[]; readonly tok: { start: number } },
    condition: boolean,
  ): void {
    const spec = condition ? CONDITION_BY_NAME[call.name] : actionSpec(call.name, input.profile);
    if (!spec) return;
    const start = call.tok.start - base;
    const add = (dependency: string): void => {
      dependencies.add(dependency);
      references.push({ start, command: call.name, dependency });
    };
    const resource = condition ? undefined : resourceReferenceOperand(call.name, input.profile);
    if (resource) {
      const arg = call.args[resource.operand];
      if (resource.kind === "item") add("inventory");
      // The assembler accepts numeric/register spellings as raw operand bytes;
      // the opcode role determines whether that byte is an ID or variable slot.
      const value =
        arg === undefined || arg.kind === "str"
          ? undefined
          : arg.kind === "num"
            ? arg.value
            : arg.index;
      if (value === undefined || value < 0 || value > 255) {
        unresolved.push({ start, command: call.name, kind: resource.kind });
      } else if (resource.variable) {
        unresolved.push({ start, command: call.name, kind: resource.kind, variable: value });
      } else if (resource.kind !== "item") {
        add(`${resource.kind}:${value}`);
      }
    }
    if (spec.operands.includes("item")) add("inventory");
    // Quoted words, numeric groups and wildcard spellings all consult the same
    // dictionary context when the final source is compiled and validated.
    if (condition && call.name === "said") add("words");
  }

  function inspectTest(test: TestExpr): void {
    switch (test.type) {
      case "cond":
        inspectCall(test, true);
        break;
      case "not":
      case "group":
        inspectTest(test.inner);
        break;
      case "and":
      case "or":
        test.parts.forEach(inspectTest);
        break;
    }
  }

  function inspectStatements(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      if (statement.type === "action") inspectCall(statement, false);
      if (statement.type === "if") {
        inspectTest(statement.test);
        inspectStatements(statement.then);
        if (statement.else_) inspectStatements(statement.else_);
      }
    }
  }
  inspectStatements(syntax.program);
  return {
    dependencies: [...dependencies].sort(),
    bindings: [...bindings].sort(),
    references,
    unresolved,
    // Prelude and whole-input errors remain explicit, with no invented authored
    // location. Only diagnostics actually in the authored input receive offsets.
    syntaxDiagnostics: syntax.diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      start: Math.max(0, diagnostic.start - base),
      end: Math.max(0, diagnostic.end - base),
      generated: diagnostic.start < base,
    })),
  };
}
