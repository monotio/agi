/**
 * The project document key grammar shared by the workspace and recovery
 * codecs: a `logic:`/`picture:`/`view:`/`sound:` resource number in 0–255 or
 * one of the named metadata documents. Pure validation only — codecs import
 * this directly so they never load the draft workspace.
 */
export function checkProjectDocumentKey(key: string): void {
  if (
    !/^(?:logic|picture|view|sound):(0|[1-9]\d{0,2})$/.test(key) &&
    !["words", "inventory", "bindings", "world", "tests", "references", "music"].includes(key)
  )
    throw new Error(`Invalid project document: ${key}`);
  const colon = key.indexOf(":");
  if (colon >= 0 && Number(key.slice(colon + 1)) > 255)
    throw new Error(`Invalid project document: ${key}`);
}
