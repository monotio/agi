// Hoisted workspace packages are resolvable from src/, but the engine may
// depend only on its own modules. Check source imports before the full gate.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve("src");
let violations = 0;
for (const file of ts.sys.readDirectory(root, [".ts"])) {
  const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
  for (const { fileName: specifier } of imports) {
    const local = specifier.startsWith("./") || specifier.startsWith("../");
    const target = relative(root, resolve(dirname(file), specifier));
    if (local && target !== ".." && !target.startsWith(`..${sep}`)) continue;
    console.error(
      `${relative(process.cwd(), file)}: ${specifier}: engine imports must stay inside src/ (AGENTS.md).`,
    );
    violations++;
  }
}
if (violations > 0) process.exitCode = 1;
else console.log("Engine dependency boundary passed.");
