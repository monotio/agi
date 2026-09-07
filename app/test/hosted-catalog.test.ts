import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { loadHostedCatalog, readHostedCatalogManifest } from "../src/hostedCatalog.ts";

const base = new URL("https://games.example/sub/catalog.json");
const manifest = (games: unknown[] = []) => ({
  format: "monotio.agi.catalog",
  version: 1,
  games,
});

test("hosted catalog rejects future versions, unsafe paths, and private files", () => {
  assert.throws(() => readHostedCatalogManifest({ ...manifest(), version: 2 }, base), /version/);
  const entry = {
    id: "garden",
    version: "1.0.0",
    title: "Garden",
    license: "CC0-1.0",
    path: "games/garden/",
    files: ["LOGDIR", "VOL.0", "WORDS.TOK"],
  };
  for (const path of [
    "../garden/",
    "/games/garden/",
    "games/%2e%2e/garden/",
    "//other/",
    "games/garden/\n../private/",
    "games/garden/\t../private/",
  ])
    assert.throws(() => readHostedCatalogManifest(manifest([{ ...entry, path }]), base), /path/);
  assert.throws(
    () =>
      readHostedCatalogManifest(
        manifest([{ ...entry, files: [...entry.files, "PROJECT.JSON"] }]),
        base,
      ),
    /file/,
  );
  assert.throws(
    () => readHostedCatalogManifest(manifest([{ ...entry, license: "" }]), base),
    /license/,
  );
  assert.throws(() => readHostedCatalogManifest(manifest([entry, entry]), base), /unique/);
  assert.throws(
    () =>
      readHostedCatalogManifest(manifest([{ ...entry, files: [...entry.files, "logdir"] }]), base),
    /duplicate file/,
  );
});

test("loader is lazy, requests exact declared files, and applies manifest provenance", async () => {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const files: Record<string, Uint8Array> = {
    ...Object.fromEntries(container.files),
    "WORDS.TOK": buildWordsTok([]),
    "GAME.JSON": new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi",
        version: 1,
        title: "Untrusted title",
        metadata: { author: "Embedded", license: "unknown" },
      }),
    ),
  };
  const names = Object.keys(files);
  const requests: string[] = [];
  const options: (RequestInit | undefined)[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    options.push(init);
    if (url === base.href)
      return new Response(
        JSON.stringify(
          manifest([
            {
              id: "garden",
              version: "1.0.0",
              title: "Hosted Garden",
              description: "A published game.",
              author: "Publisher",
              license: "CC0-1.0",
              path: "games/garden/",
              files: names,
            },
          ]),
        ),
      );
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const bytes = files[name];
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  };
  const catalog = await loadHostedCatalog(base, fetchImpl);
  assert.deepEqual(requests, [base.href]);
  assert.equal(catalog[0]?.license, "CC0-1.0");
  const opened = await catalog[0]!.load();
  assert.deepEqual(
    requests.slice(1),
    names.map((name) => new URL(`games/garden/${name}`, base).href),
  );
  assert.equal(opened.title, "Hosted Garden");
  assert.deepEqual(opened.metadata, {
    author: "Publisher",
    license: "CC0-1.0",
    description: "A published game.",
  });
  assert.ok(options.every((init) => init?.credentials === "omit" && init.redirect === "error"));
});

test("missing catalog is empty while resource and size failures are actionable", async () => {
  assert.deepEqual(
    await loadHostedCatalog(base, async () => new Response(null, { status: 404 })),
    [],
  );
  await assert.rejects(
    loadHostedCatalog(base, async () => new Response("down", { status: 503 })),
    /catalog.*503/i,
  );
  const catalog = await loadHostedCatalog(base, async (input) =>
    String(input) === base.href
      ? new Response(
          JSON.stringify(
            manifest([
              {
                id: "large",
                version: "1",
                title: "Large",
                license: "MIT",
                path: "games/large/",
                files: ["LOGDIR", "WORDS.TOK", "VOL.0"],
              },
            ]),
          ),
        )
      : new Response(new Uint8Array(1), { headers: { "content-length": "67108865" } }),
  );
  await assert.rejects(catalog[0]!.load(), /64 MB/);
  await assert.rejects(
    loadHostedCatalog(base, async () => new Response(new Uint8Array(1024 * 1024 + 1))),
    /1 MB/,
  );
  const missing = await loadHostedCatalog(base, async (input) =>
    String(input) === base.href
      ? new Response(
          JSON.stringify(
            manifest([
              {
                id: "missing",
                version: "1",
                title: "Missing",
                license: "MIT",
                path: "games/missing/",
                files: ["LOGDIR", "WORDS.TOK", "VOL.0"],
              },
            ]),
          ),
        )
      : new Response(null, { status: 404 }),
  );
  await assert.rejects(missing[0]!.load(), /file.*404/i);
});
