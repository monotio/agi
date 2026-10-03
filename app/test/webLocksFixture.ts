/** Named exclusive locks with callback acquisition, matching browser lifetime semantics. */
export function installWebLocksFixture(): void {
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(name: string, options: unknown, callback?: (lock: object | null) => unknown) {
          const run = typeof options === "function" ? (options as typeof callback) : callback;
          if ((options as { ifAvailable?: boolean })?.ifAvailable && tails.has(name))
            return Promise.resolve(run!(null));
          const next = (tails.get(name) ?? Promise.resolve()).then(() => run!({ name }));
          tails.set(name, next);
          void next
            .finally(() => {
              if (tails.get(name) === next) tails.delete(name);
            })
            .catch(() => {});
          return next;
        },
      },
    },
  });
}
