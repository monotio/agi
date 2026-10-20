import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Retained verbatim git-tag files; never derive these from the current template. */
export const releasedTemplates = [
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.2.1",
  "1.2.2",
  "1.2.3",
  "1.2.4",
].map((version) => {
  const file = readFileSync(
    new URL(`./fixtures/released-templates/v${version}.ts.txt`, import.meta.url),
    "utf8",
  );
  const literal =
    file.split("export const BASE_TEMPLATE_LOGIC0_SOURCE = ")[1]!.split("`;\n")[0]! + "`";
  return { version, source: runInNewContext(literal) as string };
});

/** Released 1.2.4 source with only its boot flag customized; retained as authored bytes. */
export const customizedLegacyBoot = readFileSync(
  new URL("./fixtures/released-templates/f199.logic", import.meta.url),
  "utf8",
);
