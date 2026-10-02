/** Refresh the generated command tables in docs/logic-language.md; --check verifies them. */
import { readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
import { commandReference } from "../src/logic/commandReference.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const path = new URL("../docs/logic-language.md", import.meta.url);
const start = "<!-- commands:start -->";
const end = "<!-- commands:end -->";
const escapeCell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const commands = commandReference(PROFILES["2.936"]);
const sections = ["action", "condition"].map((kind) => {
  const rows = commands
    .filter((command) => command.kind === kind)
    .map(
      (command) =>
        `| \`${command.signature}\` | 0x${command.code.toString(16).padStart(2, "0")} | ${escapeCell(command.help ?? "")} |`,
    );
  return `### ${kind === "action" ? "Actions" : "Conditions"} (2.936)\n\n| Signature | Opcode | Behavior |\n| --- | --- | --- |\n${rows.join("\n")}`;
});
const known = new Set(commands.map((command) => `${command.kind}:${command.signature}`));
const additions: Record<string, { signature: string; kind: string; profiles: string[] }> = {};
for (const profile of Object.values(PROFILES)) {
  for (const command of commandReference(profile)) {
    const key = `${command.kind}:${command.signature}`;
    if (known.has(key)) continue;
    const entry = (additions[key] ??= {
      signature: command.signature,
      kind: command.kind,
      profiles: [],
    });
    entry.profiles.push(profile.id);
  }
}
sections.push(
  `### Additional profile commands\n\nThese signatures belong to the listed profiles. Shared opcodes can also change behavior by profile; see [fidelity](fidelity.md).\n\n| Signature | Kind | Profiles |\n| --- | --- | --- |\n${Object.values(
    additions,
  )
    .map(
      (entry) =>
        `| \`${entry.signature}\` | ${entry.kind} | ${entry.profiles.map((id) => `\`${id}\``).join(", ")} |`,
    )
    .join("\n")}`,
);
const source = readFileSync(path, "utf8");
const begin = source.indexOf(start);
const finish = source.indexOf(end);
if (begin < 0 || finish < begin) throw new Error("Missing command table markers");
const expected = await format(
  source.slice(0, begin + start.length) +
    "\n\n" +
    sections.join("\n\n") +
    "\n\n" +
    source.slice(finish),
  { parser: "markdown" },
);
if (process.argv.includes("--check")) {
  if (source !== expected) {
    console.error(
      "LOGIC reference is out of date: run node --experimental-strip-types scripts/generate-logic-reference.ts",
    );
    process.exitCode = 1;
  }
} else writeFileSync(path, expected);
