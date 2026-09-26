/**
 * The URL names a running game and the mode it is shown in:
 * `#play/<target>` or `#create/<target>`, where the target is the installed
 * edition's folder, hash or alias, or the library project ID. The hash is the
 * source of truth for "a game is running", so a reload of either route boots
 * straight back into the autosave. Walkthroughs keep their own `#watch/` form.
 */
export type ShellMode = "play" | "create";

const PREFIXES: Record<ShellMode, string> = { play: "#play/", create: "#create/" };

/** The mode and target key a hash names, or null when it names no running game. */
export function parseGameHash(hash: string): { mode: ShellMode; key: string } | null {
  for (const mode of ["play", "create"] as const) {
    const prefix = PREFIXES[mode];
    if (!hash.startsWith(prefix)) continue;
    try {
      const key = decodeURIComponent(hash.slice(prefix.length));
      return key ? { mode, key } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Any `#play/` or `#create/` hash, readable or not: the menu clears them all. */
export function isGameRoute(hash: string): boolean {
  return Object.values(PREFIXES).some((prefix) => hash.startsWith(prefix));
}

export function gameHash(mode: ShellMode, key: string): string {
  return `${PREFIXES[mode]}${encodeURIComponent(key)}`;
}
