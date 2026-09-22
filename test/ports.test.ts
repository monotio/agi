import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openContainer } from "../src/container/container.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import type { ProfileId } from "../src/runtime/profile.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";

/**
 * Optional platform-port fixture tests. Amiga and Apple IIgs editions ship
 * the same resource containers as the PC releases under their own file
 * spellings (lowercase split files and volumes, `dirs` for the v3 combined
 * directory). Each suite opens the edition under its on-disk names, counts
 * the indexed logics and boots into the first room under the catalogued
 * port profile.
 */

interface PortCase {
  folder: string;
  profile: ProfileId;
  /** Logic records the directory indexes and the container decodes. */
  logics: number;
  /** Indexed logic entries whose records do not decode (dangling pointers). */
  corrupt: number;
  /** Room v0 holds after a restarted boot settles. */
  firstRoom: number;
}

const PORTS: readonly PortCase[] = [
  { folder: "sq1-amiga", profile: "2.411", logics: 102, corrupt: 0, firstRoom: 2 },
  { folder: "kq2-amiga", profile: "2.411", logics: 125, corrupt: 0, firstRoom: 1 },
  { folder: "sq2-amiga", profile: "2.936", logics: 118, corrupt: 1, firstRoom: 2 },
  { folder: "pq1-amiga", profile: "3.002.149", logics: 118, corrupt: 0, firstRoom: 6 },
  { folder: "goldrush-amiga", profile: "3.002.149", logics: 183, corrupt: 0, firstRoom: 129 },
  { folder: "mh2-amiga", profile: "3.002.149", logics: 96, corrupt: 0, firstRoom: 153 },
  { folder: "sq2-iigs", profile: "2.936", logics: 119, corrupt: 1, firstRoom: 2 },
];

class QuietHost implements EngineHost {
  prints: string[] = [];
  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  ackPrint(): void {}
  prompt(): void {}
  statusScreen(): void {}
}

/**
 * Read the installation under its on-disk file names: the container, not the
 * test loader, owns the port spellings (`logdir`, `vol.0`, `dirs`).
 */
function loadPort(folder: string): {
  container: ReturnType<typeof openContainer>;
  dict: ReadonlyMap<string, number>;
} {
  const fixture = findFixture(folder)!;
  const files = new Map<string, Uint8Array>();
  let dict = new Map<string, number>();
  for (const actual of fixture.files.values()) {
    const path = join(fixture.dir, actual);
    if (!statSync(path).isFile()) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (actual.toLowerCase() === "words.tok") {
      dict = new Map(parseWordsTok(bytes).map((e) => [e.word, e.id]));
    }
    files.set(actual, bytes);
  }
  return { container: openContainer(files), dict };
}

for (const port of PORTS) {
  // The mh2-amiga directory indexes picture 106 in a VOL.15 the release
  // never shipped (UNSHIPPED_VOLUMES in fixtures.ts); "shipped" exempts it.
  const skip = fixtureSkip(port.folder, [], { checkVolumes: "shipped" });

  test(`${port.folder}: resolves to its own catalog pair and indexes its logics`, { skip }, () => {
    const fixture = findFixture(port.folder);
    assert.equal(fixture?.known?.alias, port.folder);
    const { container } = loadPort(port.folder);
    let logics = 0;
    let corrupt = 0;
    for (let n = 0; n < 256; n++) {
      try {
        const payload = container.getResource("logic", n);
        if (payload) {
          assert.ok(parseLogicResource(payload).code.length > 0, `logic ${n} has bytecode`);
          logics++;
        }
      } catch {
        corrupt++;
      }
    }
    assert.equal(logics, port.logics);
    assert.equal(corrupt, port.corrupt);
  });

  test(
    `${port.folder}: restarted boot reaches room ${port.firstRoom} without an exception`,
    { skip },
    () => {
      const { container, dict } = loadPort(port.folder);
      const host = new QuietHost();
      const engine = new Engine(container, host, dict, {
        restarted: true,
        profile: port.profile,
      });
      for (let i = 0; i < 60; i++) {
        engine.tick();
        if (host.prints.length > 0) engine.ackPrint();
      }
      assert.equal(engine.vars[0], port.firstRoom);
    },
  );
}
