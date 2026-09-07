// Every ast-grep suppression must name one exact rule: a bare
// `ast-grep-ignore` (or `: all` / `: *`) silences every rule on that line,
// including rules added later. Directories given as arguments replace the
// default roots.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const defaultRoots = [
  "src",
  "app/src",
  "app/e2e",
  "app/test",
  "test",
  "scripts",
  "games/adventure-department",
];
const roots = process.argv.length > 2 ? process.argv.slice(2) : defaultRoots;
const unscoped = /ast-grep-ignore(?:\s*(?:$|--)|:\s*(?:(?:all|\*)(?:\s|$)|$))/i;
const invalid = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.(?:ts|vue|mjs)$/.test(entry.name)) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (unscoped.test(line)) invalid.push(`${file}:${index + 1}`);
      });
  }
}

for (const root of roots) walk(root);
if (invalid.length > 0) {
  console.error(
    "ast-grep suppressions must name one exact rule (`// ast-grep-ignore: <rule-id>`):\n" +
      invalid.join("\n"),
  );
  process.exitCode = 1;
}
