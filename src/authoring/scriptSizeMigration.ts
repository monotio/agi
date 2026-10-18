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
  const uncommented = source
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/[^\n]*/g, "");
  return /\bscript\s*\.\s*size\s*\(/.test(uncommented);
}

/**
 * The resize belongs inside the first-cycle block so it runs once, before the
 * room dispatch — `script.size` every cycle would empty the recorded sequence.
 * It lands after the block's own `set(f200)` marker; a logic 0 without that
 * block and without other f200 state gains a guarded block at the top, and a
 * logic 0 that already drives f200 some other way is left alone.
 */
function injectScriptSize(source: string): string | null {
  const marker = /^([ \t]*)set\(f200\);[ \t]*$/m.exec(source);
  if (marker !== null) {
    const at = marker.index + marker[0].length;
    return `${source.slice(0, at)}\n${marker[1]}script.size(200);${source.slice(at)}`;
  }
  if (/\bf200\b/.test(source.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, "")))
    return null;
  return `if (!isset(f200)) {\n  set(f200);\n  script.size(200);\n}\n${source}`;
}
