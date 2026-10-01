import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureRoot,
  startFixtureServer,
  writeFixture,
  type FixtureFiles,
} from "./fixtureServerHarness.ts";
import { BUILTIN_GAME_BUILDERS } from "../../test/game-fixture.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { canonicalResourceName } from "../../src/types.ts";
import { gameRevision, isPlayableFileName } from "../src/project/gameMetadata.ts";

/**
 * The fixture transport over the REAL middleware: a Vite dev server running
 * the production fixtureServer plugin with temporary on-disk fixtures injected
 * through its discovery seam. Nothing here copies the middleware, fulfills a
 * route, or names a contributor games/ folder.
 */

interface Reply {
  status: number;
  body: Uint8Array;
}

async function get(url: string, path: string): Promise<Reply> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
}

async function getJson(url: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, json: await res.json() };
}

/**
 * A verbatim request line: http.request writes `path` to the wire unchanged,
 * so raw dot segments, empty components and percent escapes reach the
 * middleware exactly as sent — the cases URL-parsing clients normalize away.
 */
function rawGet(url: string, path: string): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Byte-distinct playable sets: every file carries the tag. */
function playableSet(tag: string): FixtureFiles {
  const marker = new TextEncoder().encode(`|${tag}|`);
  const at = (n: number) => new Uint8Array([...marker, n]);
  return {
    "WORDS.TOK": at(0x01),
    OBJECT: at(0x02),
    LOGDIR: at(0x03),
    PICDIR: at(0x04),
    VIEWDIR: at(0x05),
    SNDDIR: at(0x06),
    "VOL.0": at(0x07),
  };
}

/** Lowercase and Amiga spellings: the manifest must keep the actual names. */
function nativeSpellingSet(tag: string): FixtureFiles {
  const marker = new TextEncoder().encode(`|${tag}|`);
  const at = (n: number) => new Uint8Array([...marker, n]);
  return {
    "words.tok": at(0x11),
    object: at(0x12),
    dirs: at(0x13),
    "vol.0": at(0x14),
    sierra: at(0x15),
  };
}

function readFileBytes(dir: string, actual: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, actual)));
}

interface Descriptor {
  folder: string;
  hash?: string;
  alias: string;
  title: string;
  revision?: string;
  wordsSha256?: string;
}

/** The manifest's descriptor for one folder. */
async function descriptorFor(
  url: string,
  folder: string,
  manifest?: Descriptor[],
): Promise<Descriptor> {
  const entries = manifest ?? ((await (await fetch(`${url}/fixtures/`)).json()) as Descriptor[]);
  const found = entries.filter((entry) => entry.folder === folder);
  assert.equal(found.length, 1, `expected exactly one descriptor for ${folder}`);
  return found[0]!;
}

/** Fetch a fixture the way the client does: encode each component once. */
async function servedFixture(
  url: string,
  target: string,
): Promise<{ names: string[]; files: Record<string, Uint8Array> }> {
  const base = `/fixtures/${encodeURIComponent(target)}`;
  const manifest = await getJson(url, `${base}/`);
  assert.equal(manifest.status, 200, `manifest for ${target}`);
  assert.ok(Array.isArray(manifest.json));
  const names = manifest.json as string[];
  const files: Record<string, Uint8Array> = {};
  for (const name of names) {
    assert.ok(isPlayableFileName(name), `manifest listed non-playable ${name}`);
    const res = await get(url, `${base}/${encodeURIComponent(name)}`);
    assert.equal(res.status, 200, `file ${name} of ${target}`);
    files[canonicalResourceName(name)] = res.body;
  }
  return { names, files };
}

test("each installed entry serves its discovered spellings and bytes under encoded unusual folder names", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    writeFixture(root, "Chamber", playableSet("chamber")),
    writeFixture(root, "Moon Room", nativeSpellingSet("moon-room")),
    writeFixture(root, "Ångström Δίκη", playableSet("unicode-dike")),
    writeFixture(root, "100% Sure", playableSet("literal-percent")),
    writeFixture(root, "what? now", playableSet("literal-query")),
    writeFixture(root, "hash#tag", playableSet("literal-hash")),
  ];
  const running = await startFixtureServer(fixtures);
  t.after(() => running.close());

  const manifest = (await (await fetch(`${running.url}/fixtures/`)).json()) as Descriptor[];
  for (const fixture of fixtures) {
    const descriptor = await descriptorFor(running.url, fixture.folder, manifest);
    assert.equal(descriptor.alias, fixture.folder);
    const { names, files } = await servedFixture(running.url, fixture.folder);
    // The manifest lists exactly the discovered playable files in their
    // actual spelling — no canonicalization, no sidecars.
    assert.deepEqual(
      [...names].sort(),
      [...fixture.files.values()].filter(isPlayableFileName).sort(),
      `manifest for ${fixture.folder}`,
    );
    // Every file's bytes are this fixture's own bytes — compared under the
    // actual spelling, since canonicalResourceName may rename (Amiga
    // spellings) — and the advertised revision is the revision of the exact
    // fetched playable set.
    for (const actual of names) {
      assert.deepEqual(
        files[canonicalResourceName(actual)],
        new Uint8Array(readFileBytes(fixture.dir, actual)),
        `${fixture.folder}/${actual}`,
      );
    }
    assert.equal(await gameRevision(files), descriptor.revision, `revision for ${fixture.folder}`);
  }
});

test("exact case spellings select their own sources; a folded spelling refuses", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The backing directories differ; only the logical folder names collide by
  // case — the portable stand-in for case-only siblings a case-folding
  // filesystem cannot hold. This exercises middleware selection, not the
  // native case-sensitive scan.
  const upper = writeFixture(root, "chamber-backing-upper", playableSet("upper"), "Chamber");
  const lower = writeFixture(root, "chamber-backing-lower", playableSet("lower"), "chamber");
  const running = await startFixtureServer([upper, lower]);
  t.after(() => running.close());

  const upperVol = await get(running.url, `/fixtures/${encodeURIComponent("Chamber")}/VOL.0`);
  assert.equal(upperVol.status, 200);
  assert.deepEqual(upperVol.body, new Uint8Array(readFileBytes(upper.dir, "VOL.0")));
  const lowerVol = await get(running.url, "/fixtures/chamber/VOL.0");
  assert.equal(lowerVol.status, 200);
  assert.deepEqual(lowerVol.body, new Uint8Array(readFileBytes(lower.dir, "VOL.0")));

  const folded = await get(running.url, "/fixtures/CHAMBER/");
  assert.equal(folded.status, 400);
  assert.match(new TextDecoder().decode(folded.body), /Chamber, chamber/);
});

test("a physical folder spelled exactly the builtin key owns it; a case sibling stays beside the virtual", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const builtin = BUILTIN_GAME_BUILDERS["synthetic"]!().files;

  // Exact collision: the physical 'synthetic' suppresses the virtual entry and
  // answers the key with its own bytes.
  const physical = writeFixture(root, "synthetic", playableSet("physical-synthetic"));
  const running = await startFixtureServer([physical]);
  t.after(() => running.close());

  const manifest = (await (await fetch(`${running.url}/fixtures/`)).json()) as Descriptor[];
  assert.equal(manifest.filter((entry) => entry.folder === "synthetic").length, 1);
  const physicalVol = await get(running.url, "/fixtures/synthetic/VOL.0");
  assert.equal(physicalVol.status, 200);
  assert.deepEqual(physicalVol.body, new Uint8Array(readFileBytes(physical.dir, "VOL.0")));
  assert.notDeepEqual(physicalVol.body, builtin["VOL.0"]);
  await running.close();

  // Case-only difference is not a collision: physical 'Synthetic' and virtual
  // 'synthetic' coexist, each answering its exact spelling. The backing
  // directory is separately named — a case-folding filesystem cannot hold
  // 'Synthetic' beside 'synthetic'; the logical folder is the transport key.
  const sibling = writeFixture(
    root,
    "synthetic-upper-backing",
    playableSet("physical-Synthetic"),
    "Synthetic",
  );
  const both = await startFixtureServer([sibling]);
  t.after(() => both.close());
  const virtualVol = await get(both.url, "/fixtures/synthetic/VOL.0");
  assert.equal(virtualVol.status, 200);
  assert.deepEqual(virtualVol.body, builtin["VOL.0"]);
  const siblingVol = await get(both.url, "/fixtures/Synthetic/VOL.0");
  assert.equal(siblingVol.status, 200);
  assert.deepEqual(siblingVol.body, new Uint8Array(readFileBytes(sibling.dir, "VOL.0")));
  const folded = await get(both.url, "/fixtures/SYNTHETIC/");
  assert.equal(folded.status, 400);
  assert.match(new TextDecoder().decode(folded.body), /Ambiguous fixture query/);
});

test("a folder named the builtin vocabulary hash wins exact selection", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const builtin = BUILTIN_GAME_BUILDERS["synthetic"]!().files;
  const named = writeFixture(root, KNOWN_GAME_HASH.SYNTHETIC, playableSet("hash-named-folder"));
  const running = await startFixtureServer([named]);
  t.after(() => running.close());

  // The exact folder spelling names the physical instance — never the builder.
  const vol = await get(running.url, `/fixtures/${KNOWN_GAME_HASH.SYNTHETIC}/VOL.0`);
  assert.equal(vol.status, 200);
  assert.deepEqual(vol.body, new Uint8Array(readFileBytes(named.dir, "VOL.0")));
  assert.notDeepEqual(vol.body, builtin["VOL.0"]);
  // The virtual entry remains reachable through its own folder key.
  const virtualVol = await get(running.url, "/fixtures/synthetic/VOL.0");
  assert.equal(virtualVol.status, 200);
  assert.deepEqual(virtualVol.body, builtin["VOL.0"]);
});

test("an altered builtin-derived folder keeps its own descriptor and bytes beside the virtual", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = BUILTIN_GAME_BUILDERS["synthetic"]!().files;
  // The shared vocabulary (WORDS.TOK + OBJECT pair) with different playable
  // bytes: one fingerprint, two distinct instances.
  const remix = writeFixture(root, "synthetic-remix", {
    ...playableSet("synthetic-remix"),
    "WORDS.TOK": built["WORDS.TOK"]!,
    OBJECT: built["OBJECT"]!,
  });
  const running = await startFixtureServer([remix]);
  t.after(() => running.close());

  const manifest = (await (await fetch(`${running.url}/fixtures/`)).json()) as Descriptor[];
  const remixDescriptor = await descriptorFor(running.url, "synthetic-remix", manifest);
  const virtualDescriptor = await descriptorFor(running.url, "synthetic", manifest);
  assert.notEqual(remixDescriptor.revision, virtualDescriptor.revision);

  const remixVol = await get(running.url, "/fixtures/synthetic-remix/VOL.0");
  assert.deepEqual(remixVol.body, new Uint8Array(readFileBytes(remix.dir, "VOL.0")));
  const virtualVol = await get(running.url, "/fixtures/synthetic/VOL.0");
  assert.deepEqual(virtualVol.body, built["VOL.0"]);

  // The shared vocabulary spelling is a convenience query, not an identity:
  // two instances answer and neither is preferred — the transport refuses.
  const shared = await get(running.url, `/fixtures/${KNOWN_GAME_HASH.SYNTHETIC}/VOL.0`);
  assert.equal(shared.status, 400);
  assert.match(new TextDecoder().decode(shared.body), /Ambiguous fixture query/);
});

test("builtin alias and vocabulary hash reach the builder when no physical entry collides", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrelated = writeFixture(root, "unrelated-game", playableSet("unrelated"));
  const running = await startFixtureServer([unrelated]);
  t.after(() => running.close());

  for (const [alias, key] of [
    ["synthetic", KNOWN_GAME_HASH.SYNTHETIC],
    ["adventure-department", KNOWN_GAME_HASH.ADVENTURE_DEPARTMENT],
  ] as const) {
    const built = BUILTIN_GAME_BUILDERS[alias]!().files;
    const byAlias = await servedFixture(running.url, alias);
    const byHash = await servedFixture(running.url, key);
    for (const name of Object.keys(built).filter(isPlayableFileName)) {
      assert.deepEqual(byAlias.files[canonicalResourceName(name)], built[name], `${alias}/${name}`);
      assert.deepEqual(byHash.files[canonicalResourceName(name)], built[name], `${key}/${name}`);
    }
  }
});

test("unresolved targets are 404 and never probe the filesystem", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const served = writeFixture(root, "served-game", playableSet("served"));
  // On disk but not discovered: the transport must not guess a path for it.
  writeFixture(root, "undiscovered-sibling", playableSet("undiscovered"));
  const running = await startFixtureServer([served]);
  t.after(() => running.close());

  assert.equal((await get(running.url, "/fixtures/undiscovered-sibling/")).status, 404);
  assert.equal((await get(running.url, "/fixtures/definitely-not-installed/")).status, 404);
  assert.equal((await get(running.url, "/fixtures/definitely-not-installed/LOGDIR")).status, 404);
  assert.equal((await get(running.url, "/fixtures/served-game/NOT.A.FILE")).status, 404);

  // A real contributor folder the injected discovery did not return still 404s —
  // the deleted join(gamesRoot, target) fallback is what this pins down. A name
  // a builtin owns answers the virtual entry instead, so skip those.
  const gamesRoot = fileURLToPath(new URL("../../games/", import.meta.url));
  if (existsSync(gamesRoot)) {
    const present = readdirSync(gamesRoot).find(
      (name) =>
        !name.startsWith(".") &&
        !Object.hasOwn(BUILTIN_GAME_BUILDERS, name.toLowerCase()) &&
        (statSync(join(gamesRoot, name), { throwIfNoEntry: false })?.isDirectory() ?? false),
    );
    if (present) {
      assert.equal(
        (await get(running.url, `/fixtures/${encodeURIComponent(present)}/`)).status,
        404,
        `games/${present}/ exists on disk but was not discovered`,
      );
    }
  }
});

test("sidecar files are never listed or served; GAME.JSON still feeds the descriptor", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeFixture(root, "documented-game", {
    ...playableSet("documented"),
    "GAME.JSON": JSON.stringify({ format: "monotio.agi", version: 1, title: "Declared Title" }),
    "TESTS.JSON": "{}",
    "NOTES.TXT": "internal notes",
  });
  const running = await startFixtureServer([fixture]);
  t.after(() => running.close());

  const descriptor = await descriptorFor(running.url, "documented-game");
  // Descriptor construction reads GAME.JSON, but it is not playable content.
  assert.equal(descriptor.title, "Declared Title");
  const { names } = await servedFixture(running.url, "documented-game");
  for (const sidecar of ["GAME.JSON", "TESTS.JSON", "NOTES.TXT"]) {
    assert.ok(!names.includes(sidecar), `manifest listed ${sidecar}`);
    for (const spelling of [sidecar, sidecar.toLowerCase()]) {
      const res = await get(
        running.url,
        `/fixtures/${encodeURIComponent("documented-game")}/${encodeURIComponent(spelling)}`,
      );
      assert.equal(res.status, 404, `${sidecar} as ${spelling}`);
    }
  }
});

test("malformed, traversal and extra-component spellings refuse and leave service healthy", async (t) => {
  const root = fixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeFixture(root, "served-game", playableSet("served"));
  const running = await startFixtureServer([fixture]);
  t.after(() => running.close());

  const refused: [string, number][] = [
    // decoded separators and control characters
    ["/fixtures/%2f/", 403],
    ["/fixtures/a%2fb/", 403],
    ["/fixtures/%5c/", 403],
    ["/fixtures/x%5cy/", 403],
    ["/fixtures/%00/", 403],
    ["/fixtures/x%00y/", 403],
    ["/fixtures/%0a/", 403],
    ["/fixtures/%7f/", 403],
    // dot segments, raw or encoded
    ["/fixtures/../vite.config.ts", 403],
    ["/fixtures/%2e%2e/", 403],
    ["/fixtures/%2e%2e/vite.config.ts", 403],
    ["/fixtures/./", 403],
    ["/fixtures/synthetic/../served-game/VOL.0", 403],
    ["/fixtures/synthetic/%2e%2e", 403],
    // empty and extra components
    ["/fixtures//", 403],
    ["/fixtures/synthetic//VOL.0", 403],
    ["/fixtures/a/b/c", 403],
    ["/fixtures/synthetic/VOL.0/extra", 403],
    // malformed escapes and invalid UTF-8
    ["/fixtures/%zz/", 403],
    ["/fixtures/100%/", 403],
    ["/fixtures/%ff/", 403],
    ["/fixtures/%c3%28/", 403],
    ["/fixtures/%c3", 403],
  ];
  for (const [path, status] of refused) {
    const res = await rawGet(running.url, path);
    assert.equal(res.status, status, `expected ${status} for ${path}, got ${res.status}`);
  }

  // Percent survives ONE decode: %252F is the literal name "%2F", never a
  // second decode into a separator.
  assert.equal((await rawGet(running.url, "/fixtures/%252e%252e/")).status, 404);
  assert.equal((await rawGet(running.url, "/fixtures/synthetic/%252F")).status, 404);

  // Controlled refusals disturb nothing: valid requests still resolve.
  const healthy = await get(running.url, "/fixtures/served-game/VOL.0");
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.body, new Uint8Array(readFileBytes(fixture.dir, "VOL.0")));
  const builtin = await get(running.url, "/fixtures/synthetic/VOL.0");
  assert.equal(builtin.status, 200);
});
