/**
 * Manual proof: autosave survives Vite HMR. Run in an isolated checkout because
 * this script temporarily edits App.vue and main.ts to trigger actual updates.
 *
 *   cd app
 *   npx vite --mode test --port 5301
 *   node --experimental-strip-types e2e/manual/hmr-resume.mjs
 *
 * AGI_HMR_PORT overrides the port. Requires games/kq1/; reports a skip when absent.
 * Source edits are restored in finally blocks. Check git status if interrupted.
 *
 * Three cases, matching the three hooks in App.vue:
 *
 *  (b) a hot update of App.vue re-runs setup and builds a NEW engine with no
 *      page reload. `import.meta.hot.dispose` flushes and hands the image over
 *      in `import.meta.hot.data`; the check asserts the document id did NOT
 *      change and the game came back in the same room, on the same pixel.
 *  (a) a change to a module with no accepting importer (main.ts) forces a full
 *      page reload. `vite:beforeFullReload` listeners are awaited by Vite's
 *      client before `location.reload()`, so the bounded flush really lands.
 *  (c) the case that makes (a) and (b) worth having: walk ego AFTER the last
 *      five-second snapshot and trigger the reload immediately. Only a flush
 *      before the reload can carry the new position over — with the hooks
 *      removed this one resumes 12px away, on the stale cadence snapshot,
 *      while (a) and (b) still pass from localStorage.
 */
import { chromium } from "playwright";
import { fixtureSkip } from "../../../test/fixtures.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const missingFixture = fixtureSkip("kq1");
if (missingFixture) {
  console.log(`[fixture skipped] ${missingFixture}`);
  process.exit(0);
}

const PORT = process.env["AGI_HMR_PORT"] ?? "5301";
const URL = `http://localhost:${PORT}/`;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "../../src/App.vue");
const MAIN = join(HERE, "../../src/main.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__LOAD_ID__ = `${Date.now()}-${Math.random()}`;
});
page.on("console", (m) => {
  const t = m.text();
  if (/hot updated|full reload|page reload/i.test(t)) console.log("  [vite]", t.slice(0, 120));
});

const hook = () =>
  page.evaluate(() => ({ ...(window.__AGI_TEXT__ ?? {}), loadId: window.__LOAD_ID__ }));
async function poll(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const h = await hook().catch(() => ({}));
    if (fn(h)) return h;
    if (Date.now() > end)
      throw new Error(
        `timeout: ${label} (room=${h.room} cycle=${h.cycle} load=${String(h.loadId).slice(0, 8)})`,
      );
    await sleep(150);
  }
}
async function playToRestedCourtyard() {
  await page.getByTestId("boot-kq1").click();
  await page.getByTestId("title-prompt-hint").waitFor({ timeout: 20000 });
  await page.locator(".screen").click();
  await poll((h) => (h.rows?.[0] ?? "").includes("Score:"), "courtyard");
  await page.locator("canvas.game-surface:visible").click();
  await page.keyboard.down("ArrowLeft");
  await sleep(700);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // AGI: press the direction again to stop.
  await sleep(400);
}
async function settledReference(label) {
  const now = await hook();
  const h = await poll((x) => x.autosave > now.cycle, `${label}: autosave stored`, 20000);
  console.log(
    `${label}  load=%s room=%d ego=(%d,%d) autosaveCycle=%d`,
    String(h.loadId).slice(0, 8),
    h.room,
    h.egoX,
    h.egoY,
    h.autosave,
  );
  return h;
}

await page.goto(URL);
await playToRestedCourtyard();
const before = await settledReference("BEFORE ");

// ---- (b) hot update of App.vue: setup re-runs, no page reload, in-memory handover
const appSrc = readFileSync(APP, "utf8");
console.log("--- editing App.vue <script setup> ---");
writeFileSync(
  APP,
  appSrc.replace(
    'const inputLine = ref("");',
    'const inputLine = ref("");\nconst HMR_PROBE = 1;\nvoid HMR_PROBE;',
  ),
);
let ok = true;
try {
  await page.getByTestId("resume-caption").waitFor({ timeout: 30000 });
  const after = await poll((h) => h.room > 0, "room after App.vue hot update", 20000);
  const reloaded = after.loadId !== before.loadId;
  console.log(
    "AFTER-B load=%s room=%d ego=(%d,%d) pageReloaded=%s",
    String(after.loadId).slice(0, 8),
    after.room,
    after.egoX,
    after.egoY,
    reloaded,
  );
  console.log(
    reloaded
      ? "  FAIL: expected an in-memory handover, got a page reload"
      : "  PASS: no page reload; engine handed over via import.meta.hot.data",
  );
  console.log(
    after.room === before.room
      ? "  PASS: same room"
      : `  FAIL: room ${after.room} != ${before.room}`,
  );
  const dx = Math.abs(after.egoX - before.egoX),
    dy = Math.abs(after.egoY - before.egoY);
  console.log(
    dx <= 6 && dy <= 6 ? `  PASS: ego within ${dx},${dy}px` : `  FAIL: ego moved ${dx},${dy}px`,
  );
  ok &&= !reloaded && after.room === before.room && dx <= 6 && dy <= 6;
} finally {
  writeFileSync(APP, appSrc);
  await sleep(2000);
}

await page
  .getByTestId("resume-caption")
  .waitFor({ timeout: 30000 })
  .catch(() => {});
await poll((h) => h.room > 0, "room after revert", 20000);
await sleep(1200);
const before2 = await settledReference("BEFORE2");

// ---- (a) full page reload: main.ts has no accepting importer
const mainSrc = readFileSync(MAIN, "utf8");
console.log("--- editing main.ts (forces vite:beforeFullReload) ---");
writeFileSync(MAIN, mainSrc + "\n// hmr probe\n");
try {
  const after = await poll(
    (h) => h.loadId && h.loadId !== before2.loadId,
    "full page reload",
    30000,
  );
  console.log("  page reloaded (new document id %s)", String(after.loadId).slice(0, 8));
  await page.getByTestId("resume-caption").waitFor({ timeout: 30000 });
  const done = await poll((h) => h.room > 0, "room after full reload", 20000);
  console.log(
    "AFTER-A load=%s room=%d ego=(%d,%d)",
    String(done.loadId).slice(0, 8),
    done.room,
    done.egoX,
    done.egoY,
  );
  console.log(
    done.room === before2.room
      ? "  PASS: same room after full reload"
      : `  FAIL: room ${done.room}`,
  );
  const dx = Math.abs(done.egoX - before2.egoX),
    dy = Math.abs(done.egoY - before2.egoY);
  console.log(
    dx <= 6 && dy <= 6 ? `  PASS: ego within ${dx},${dy}px` : `  FAIL: ego moved ${dx},${dy}px`,
  );
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("monotio_agi.autosave.kq1") ?? "null"),
  );
  console.log("  stored autosave: cycle=%d room=%d", stored?.cycle, stored?.room);
  ok &&= done.room === before2.room && dx <= 6 && dy <= 6;
} finally {
  writeFileSync(MAIN, mainSrc);
}
// ---- (c) the flush earns its keep: walk, then reload INSIDE the 5s cadence
// window. Only a flush before the reload can carry the new position over.
await page
  .getByTestId("resume-caption")
  .waitFor({ timeout: 30000 })
  .catch(() => {});
await poll((h) => h.room > 0, "room after reload", 20000);
const cadence = await hook();
const fresh = await poll(
  (h) => h.autosave > cadence.cycle,
  "a cadence autosave just landed",
  20000,
);
console.log("--- walking AFTER the last cadence autosave, then editing main.ts at once ---");
await page.locator("canvas.game-surface:visible").click();
await page.keyboard.down("ArrowRight");
await poll((h) => Math.abs(h.egoX - fresh.egoX) >= 12, "walk beyond the older snapshot");
await page.keyboard.up("ArrowRight");
await page.keyboard.press("ArrowRight"); // AGI: press the direction again to stop.
await sleep(200);
const moved = await hook();
console.log(
  "MOVED   ego=(%d,%d) (last stored snapshot was at ego=(%d,%d))",
  moved.egoX,
  moved.egoY,
  fresh.egoX,
  fresh.egoY,
);
const walkedAway = Math.abs(moved.egoX - fresh.egoX) > 6;
console.log(
  walkedAway
    ? "  (ego really left the snapshotted spot)"
    : "  WARN: ego barely moved; case (c) is not discriminating",
);
const mainSrc2 = readFileSync(MAIN, "utf8");
writeFileSync(MAIN, mainSrc2 + "\n// hmr probe 2\n");
try {
  await poll((h) => h.loadId && h.loadId !== moved.loadId, "full page reload", 30000);
  await page.getByTestId("resume-caption").waitFor({ timeout: 30000 });
  const done = await poll((h) => h.room > 0, "room after flush-window reload", 20000);
  const dNew = Math.abs(done.egoX - moved.egoX);
  const dOld = Math.abs(done.egoX - fresh.egoX);
  console.log(
    "AFTER-C ego=(%d,%d): %dpx from where the walk ended, %dpx from the older snapshot",
    done.egoX,
    done.egoY,
    dNew,
    dOld,
  );
  console.log(
    dNew <= 6
      ? "  PASS: the pre-reload flush carried the walk over"
      : "  FAIL: resumed from the stale cadence snapshot",
  );
  ok &&= walkedAway && dNew <= 6;
} finally {
  writeFileSync(MAIN, mainSrc2);
}

await page.screenshot({ path: join(HERE, "../../test-results/hmr-resume.png") });
await browser.close();
console.log(ok ? "\nHMR CHECK: PASS" : "\nHMR CHECK: FAIL");
process.exit(ok ? 0 : 1);
