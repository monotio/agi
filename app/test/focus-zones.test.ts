import assert from "node:assert/strict";
import { test } from "node:test";
import { useFocusZones, type FocusZone } from "../src/shell/commands/useFocusZones.ts";

test("focus zones cycle in workspace order, skip unavailable zones and announce changes", () => {
  const calls: string[] = [];
  const roots = new Map<FocusZone, HTMLElement>();
  for (const name of ["parts", "game", "agent"] as const)
    roots.set(name, {
      focus() {
        calls.push(name);
      },
      contains(target: unknown) {
        return target === this;
      },
      setAttribute() {},
      removeAttribute() {},
    } as unknown as HTMLElement);
  const focus = useFocusZones(() => roots);
  assert.equal(focus.active.value, undefined);
  focus.cycle();
  assert.equal(focus.active.value, "parts");
  assert.equal(focus.announcement.value, "Parts focused");
  focus.cycle();
  focus.cycle();
  focus.cycle();
  assert.deepEqual(calls, ["parts", "game", "agent", "parts"]);
  focus.cycle(-1);
  assert.equal(focus.active.value, "agent");
  assert.equal(focus.focus("editor"), false);
  focus.track(roots.get("game")!);
  assert.equal(focus.active.value, "game");
  focus.track({} as Node);
  assert.equal(focus.active.value, undefined);
  focus.dispose();
  assert.equal(focus.active.value, undefined);
});

test("a game nested inside a picture editor owns its focused keys", () => {
  const game = { contains: (target: unknown) => target === input };
  const editor = { contains: (target: unknown) => target === input || target === game };
  const input = {};
  const zones = useFocusZones(
    () =>
      new Map([
        ["editor", editor],
        ["game", game],
      ]) as unknown as ReadonlyMap<FocusZone, HTMLElement>,
  );
  assert.equal(zones.zoneFor(input as Node), "game");
});
