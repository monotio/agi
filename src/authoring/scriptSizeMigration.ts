import type { ProjectContent } from "./projectContent.ts";

/**
 * One-time migration for projects authored before the script buffer took its
 * authentic 50-pair default: logic 0 learns the same `script.size(200)` the
 * base template now ships, as an ordinary source edit the History records
 * like any other. Returns the migrated documents, or null when logic 0
 * already sizes its script buffer or has no editable source — imported
 * original games have no source document and are never touched.
 */
export function migrateScriptSize(
  documents: Readonly<Record<string, ProjectContent>>,
): Record<string, ProjectContent> | null {
  const source = documents["logic:0"];
  if (typeof source !== "string" || hasScriptSize(source)) return null;
  const migrated = injectScriptSize(source);
  return migrated === null ? null : { ...documents, "logic:0": migrated };
}

/** `script.size` call sites outside comments and string literals. */
function hasScriptSize(source: string): boolean {
  const uncommented = source.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, "");
  return /\bscript\s*\.\s*size\s*\(/.test(uncommented);
}

/**
 * The resize belongs inside the first-cycle block so it runs once, before the
 * room dispatch — `script.size` every cycle would empty the recorded sequence.
 * Only the template's boot shape is recognized: a `set(f200)` marker inside a
 * `!isset(f200)` guard. A logic 0 the author shaped some other way is left
 * alone rather than rewritten with a guessed guard flag.
 */
function injectScriptSize(source: string): string | null {
  if (!/!\s*isset\s*\(\s*f200\s*\)/.test(source)) return null;
  const marker = /^([ \t]*)set\(f200\);[ \t]*$/m.exec(source);
  if (marker === null) return null;
  const at = marker.index + marker[0].length;
  return `${source.slice(0, at)}\n${marker[1]}script.size(200);${source.slice(at)}`;
}
