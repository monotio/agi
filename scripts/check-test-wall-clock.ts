import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Exact source-line checks complement ast-grep's structural comment adjacency. */
export function unmarkedTestWaits(source: string): number[] {
  const file = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const markedLines = new Set<number>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia &&
      /^\/\/ wall-clock: \S/.test(scanner.getTokenText())
    ) {
      markedLines.add(file.getLineAndCharacterOfPosition(scanner.getTokenPos()).line);
    }
  }
  const timerAliases = new Set<string>();
  const waits: number[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!/^(?:node:)?timers\/promises$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "setTimeout")
          timerAliases.add(binding.name.text);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : "";
      let promiseTimer = false;
      if (name === "setTimeout") {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isNewExpression(parent) && parent.expression.getText(file) === "Promise") {
            promiseTimer = true;
            break;
          }
        }
      }
      if (name === "sleep" || name === "waitForTimeout" || timerAliases.has(name) || promiseTimer) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
        const marked = markedLines.has(line) || markedLines.has(line - 1);
        if (!marked) waits.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return waits;
}

function scan(directory: string): string[] {
  const findings: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) findings.push(...scan(file));
    else if (entry.name.endsWith(".ts")) {
      for (const line of unmarkedTestWaits(readFileSync(file, "utf8")))
        findings.push(`${file}:${line}`);
    }
  }
  return findings;
}

export function checkTestWallClock(): void {
  const findings = ["test", "app/test", "evals/tests"].flatMap(scan);
  if (findings.length) {
    console.error(
      "Test waits need an observable condition, controlled clock, or // wall-clock: reason:\n" +
        findings.join("\n"),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkTestWallClock();
}
