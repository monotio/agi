// scripts/verify-deploy.ts against fixture sites on a local HTTP server: the
// deploy check must tell the artifact this run built from any other build.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyDeploy } from "../scripts/verify-deploy.ts";

const CURRENT = "1".repeat(40);
const OLDER = "0".repeat(40);

type Site = Record<string, string>;

const index = (build: string, entry: string, style: string): string =>
  [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8" />',
    `<meta name="agi-build" content="${build}">`,
    "<title>AGI IS HERE — Play. Create. Remix. | Monotio</title>",
    `<script type="module" crossorigin src="/assets/${entry}"></script>`,
    `<link rel="stylesheet" crossorigin href="/assets/${style}">`,
    "</head>",
    '<body><div id="app"></div></body>',
    "</html>",
  ].join("\n");

const build = (commit: string, tag: string): Site => ({
  "index.html": index(commit, `index-${tag}.js`, `index-${tag}.css`),
  [`assets/index-${tag}.js`]: `console.log(${JSON.stringify(tag)});`,
  [`assets/index-${tag}.css`]: `body{--build:${JSON.stringify(tag)}}`,
});

const current = build(CURRENT, "B2");
const older = build(OLDER, "A1");

// What the server answers; each test replaces it.
let served: Site = current;
let nosniff = true;
/** A configured header the server leaves out, or sends with another value. */
let omitted: string | null = null;
let altered: string | null = null;
const GLOBAL_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Content-Security-Policy": "default-src 'self'; object-src 'none'",
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};
let server: Server;
let url = "";
let scratch = "";

const writeArtifact = (name: string, site: Site): string => {
  const root = join(scratch, name);
  for (const [path, body] of Object.entries(site)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(
    join(root, "staticwebapp.config.json"),
    JSON.stringify({ globalHeaders: GLOBAL_HEADERS }),
  );
  return root;
};

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "agi-verify-deploy-"));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1) || "index.html";
    for (const [name, value] of Object.entries(GLOBAL_HEADERS))
      if (name !== omitted && !(name === "X-Content-Type-Options" && !nosniff))
        res.setHeader(name, name === altered ? "other" : value);
    const body = served[path];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/`;
});

after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

let artifacts = 0;
const verify = (artifact: Site, commit = CURRENT) =>
  verifyDeploy({
    url,
    commit,
    artifact: writeArtifact(`artifact-${++artifacts}`, artifact),
    attempts: 1,
    delayMs: 0,
    log: () => {},
  });

test("the matching artifact verifies", async () => {
  served = current;
  nosniff = true;
  const result = await verify(current);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
});

test("an older deployment still at the edge fails on identity and assets", async () => {
  served = older;
  nosniff = true;
  const result = await verify(current);
  assert.equal(result.ok, false);
  const report = result.report.join("\n");
  assert.match(report, new RegExp(`expected build ${CURRENT}`));
  assert.match(report, new RegExp(`observed build ${OLDER}`));
  assert.match(report, /index-B2\.js/);
  assert.match(report, /index-A1\.js/);
});

test("an artifact built for another commit fails", async () => {
  served = current;
  nosniff = true;
  const result = await verify(current, OLDER);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("artifact")));
});

test("a served index with a mismatched identifier fails", async () => {
  served = { ...current, "index.html": index(OLDER, "index-B2.js", "index-B2.css") };
  nosniff = true;
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("build identifier")));
});

test("a missing asset fails", async () => {
  const { ["assets/index-B2.css"]: _missing, ...rest } = current;
  served = rest;
  nosniff = true;
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("assets/index-B2.css")));
  assert.match(result.report.join("\n"), /HTTP 404/);
});

test("an asset with the wrong bytes fails on its digest", async () => {
  served = { ...current, "assets/index-B2.js": "console.log('tampered');" };
  nosniff = true;
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("assets/index-B2.js")));
  assert.match(result.report.join("\n"), /expected sha256 [0-9a-f]{64}/);
});

test("a response without nosniff fails", async () => {
  served = current;
  nosniff = false;
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("nosniff")));
});

for (const name of Object.keys(GLOBAL_HEADERS).filter((n) => n !== "X-Content-Type-Options")) {
  test(`a missing or changed ${name} header fails`, async () => {
    served = current;
    nosniff = true;
    for (const mode of ["omitted", "altered"] as const) {
      omitted = mode === "omitted" ? name : null;
      altered = mode === "altered" ? name : null;
      const result = await verify(current);
      omitted = altered = null;
      assert.equal(result.ok, false, `${mode} ${name}`);
      assert.ok(
        result.problems.some((problem) => problem.toLowerCase().includes(name.toLowerCase())),
      );
    }
  });
}

test("an artifact without a header configuration fails", async () => {
  served = current;
  nosniff = true;
  const root = writeArtifact("artifact-no-config", current);
  rmSync(join(root, "staticwebapp.config.json"));
  const result = await verifyDeploy({
    url,
    commit: CURRENT,
    artifact: root,
    attempts: 1,
    delayMs: 0,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("staticwebapp.config.json")));
});

test("an index without the app mount fails", async () => {
  served = { ...current, "index.html": current["index.html"]!.replace(' id="app"', "") };
  nosniff = true;
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("mount")));
});

test("verification retries until the edge serves the new build", async () => {
  served = older;
  nosniff = true;
  // The first two attempts see the older build; the edge catches up during
  // the second wait. The wait is injected: no timer, whatever the load.
  const waits: number[] = [];
  const result = await verifyDeploy({
    url,
    commit: CURRENT,
    artifact: writeArtifact("retry", current),
    attempts: 5,
    delayMs: 5000,
    log: () => {},
    wait: async (ms) => {
      waits.push(ms);
      if (waits.length === 2) served = current;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [5000, 5000]);
});
