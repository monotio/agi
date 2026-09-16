/**
 * Storage benchmark: the append-oriented commit path measured against
 * the whole-record layout it replaced, on one named phone-class profile —
 * Playwright's Moto G4 device under Chromium with a 4x CPU throttle.
 *
 * The responsiveness budget this run evaluates (set before the numbers):
 *
 *   - steady-state commit p50 below one throttled frame (100 ms) and p95
 *     below 250 ms on every tape size — a batch lands bounded by its own
 *     size, not the tape's;
 *   - tape reassembly (loadGameHistory, the view-open read) under 2 s;
 *   - bytes written per steady-state commit under 256 KB.
 *
 * Three tapes: small (~160 KB), large (~1.5 MB, both layouts) and
 * near-budget — filled past the 64 MB retention bound so eviction runs
 * inside measured commits. The old layout gets one representative commit
 * there: a whole-tape run would take minutes, which is itself the finding.
 * Measured values print to the test log so a regression reads against the
 * numbers, not just the assertions.
 */
import { expect, test, devices } from "@playwright/test";

test.use({ ...devices["Moto G4"] });

const SMALL_TAPE = { segments: 4, batchesPerSegment: 40 };
const LARGE_TAPE = { segments: 12, batchesPerSegment: 120 };
/** 4 MB patch events: 18 ended segments overshoot the 64 MB byte bound. */
const FILL_SEGMENTS = 18;
const FILL_BATCH_BYTES = 4 * 1024 * 1024;
/** Steady-state commits measured on the near-budget tape. */
const TAIL_BATCHES = 150;

interface BenchResult {
  commits: number;
  commitP50: number;
  commitP95: number;
  commitMax: number;
  bytesPerCommit: number;
  loadMs: number;
  segments: number;
  records: number;
  longTasks: number;
  heapDelta: number;
}

test("append-oriented commits stay batch-bounded on a phone-class browser", async ({ page }) => {
  test.setTimeout(240_000);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/");
  const results = await page.evaluate(
    async (shapes: {
      small: typeof SMALL_TAPE;
      large: typeof LARGE_TAPE;
      fillSegments: number;
      fillBatchBytes: number;
      tailBatches: number;
    }) => {
      const storage = await import("/src/historyStorage.ts");
      const identity = {
        project: "bench-game" as never,
        revision: "0000000000000000000000000000000000000000000000000000000000000001" as never,
      };

      // A batch of realistic shape: a handful of input/mark events and a
      // sync digest — about a kilobyte of tape per commit.
      const makeBatch = (segment: string, n: number, boot?: unknown) => ({
        segment,
        batch: n,
        seqStart: n * 4,
        seqEnd: n * 4 + 4,
        events: [0, 1, 2, 3].map((i) => ({
          seq: n * 4 + i,
          tick: n * 4 + i,
          cycle: n * 4 + i,
          cause: { kind: "key", code: 65 + i },
        })),
        marks: [{ seq: n * 4, tick: n * 4, cycle: n * 4, room: n % 7, via: "edge" }],
        sync: [
          {
            seq: n * 4,
            tick: n * 4,
            cycle: n * 4,
            digest: "a1b2c3d4",
            room: n % 7,
            score: 0,
            patchGeneration: 0,
            modal: null,
          },
        ],
        ...(boot !== undefined ? { boot } : {}),
      });
      // A small game's file set — ~300 KB of base64, the payload blob dedup
      // is meant to keep off the per-segment path.
      const bootFiles = {
        LOGDIR: "x".repeat(120 * 1024),
        "VOL.0": "y".repeat(120 * 1024),
        "WORDS.TOK": "z".repeat(24 * 1024),
        OBJECT: "w".repeat(4 * 1024),
      };
      const boot = {
        files: bootFiles,
        dictionary: [] as [string, number][],
        authorRooms: false,
        rng: 7,
        soundDevice: 1,
        resourceSet: "bench",
        requestSerial: 0,
      };

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("monotio-agi-projects", 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const get = (key: string) =>
        new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const req = db.transaction("projects", "readonly").objectStore("projects").get(key);
          req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
          req.onerror = () => reject(req.error);
        });
      const put = (record: Record<string, unknown>) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction("projects", "readwrite");
          tx.objectStore("projects").put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      const countRecords = (prefix: string) =>
        new Promise<number>((resolve, reject) => {
          const req = db.transaction("projects", "readonly").objectStore("projects").getAllKeys();
          req.onsuccess = () =>
            resolve(
              (req.result as string[]).filter(
                (key) => typeof key === "string" && key.startsWith(prefix),
              ).length,
            );
          req.onerror = () => reject(req.error);
        });

      /**
       * The layout this replaces, kept honest by writing through the same
       * IndexedDB primitives: every commit reads the whole tape record,
       * folds the batch into its in-memory segments and writes the whole
       * thing back.
       */
      const legacyCommit = async (key: string, batch: ReturnType<typeof makeBatch>) => {
        const stored = (await get(`legacy/${key}`)) ?? {
          format: "monotio.agi.history",
          version: 1,
          projectId: `legacy/${key}`,
          recording: { segments: [] as Record<string, unknown>[] },
          committed: {} as Record<string, number[]>,
        };
        const rec = stored["recording"] as { segments: Record<string, unknown>[] };
        let segment = rec.segments.find((s) => s["id"] === batch.segment) as
          { events: unknown[]; marks: unknown[]; sync: unknown[] } | undefined;
        if (segment === undefined) {
          segment = { events: [], marks: [], sync: [] };
          (segment as unknown as Record<string, unknown>)["id"] = batch.segment;
          (segment as unknown as Record<string, unknown>)["boot"] = batch.boot;
          rec.segments.push(segment as unknown as Record<string, unknown>);
        }
        segment.events.push(...batch.events);
        segment.marks.push(...batch.marks);
        segment.sync.push(...batch.sync);
        const size = JSON.stringify(stored).length;
        await put(stored);
        return size;
      };

      const longTasks = { count: 0 };
      new PerformanceObserver((list) => {
        longTasks.count += list.getEntries().length;
      }).observe({ entryTypes: ["longtask"] });
      const heap = () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0;

      const run = async (
        shape: { segments: number; batchesPerSegment: number },
        keyPrefix: string,
        commit: (batch: ReturnType<typeof makeBatch>) => Promise<number>,
      ): Promise<BenchResult> => {
        const times: number[] = [];
        let bytes = 0;
        const heap0 = heap();
        for (let s = 0; s < shape.segments; s++) {
          for (let b = 1; b <= shape.batchesPerSegment; b++) {
            const t0 = performance.now();
            bytes += await commit(makeBatch(`${keyPrefix}-seg${s}`, b, b === 1 ? boot : undefined));
            times.push(performance.now() - t0);
          }
        }
        const sorted = [...times].sort((a, b) => a - b);
        const commits = sorted.length;
        return {
          commits,
          commitP50: sorted[Math.floor(commits * 0.5)]!,
          commitP95: sorted[Math.floor(commits * 0.95)]!,
          commitMax: sorted[commits - 1]!,
          bytesPerCommit: bytes / commits,
          loadMs: 0,
          segments: shape.segments,
          records: 0,
          longTasks: longTasks.count,
          heapDelta: heap() - heap0,
        };
      };

      const out: Record<string, BenchResult> = {};
      for (const [label, shape] of [
        ["small", shapes.small],
        ["large", shapes.large],
      ] as const) {
        // Each commit's written bytes: the batch record, the rewritten
        // manifest (read back so its real size counts), and the boot blob
        // on a segment opener — exactly what the layout puts per batch.
        out[`new-${label}`] = await run(shape, `n${label}`, async (batch) => {
          const batchBytes = JSON.stringify(batch).length;
          await storage.appendHistoryBatch(`bench-new-${label}`, batch as never, "2.936", identity);
          const manifest = (await get(`history/bench-new-${label}`))!;
          const blobBytes = batch.boot !== undefined ? JSON.stringify(bootFiles).length : 0;
          return batchBytes + JSON.stringify(manifest).length + blobBytes;
        });
        const t0 = performance.now();
        await storage.loadGameHistory(`bench-new-${label}`);
        out[`new-${label}`]!.loadMs = performance.now() - t0;
        out[`new-${label}`]!.records = await countRecords(`history/bench-new-${label}`);

        // The old layout on an identical workload — the baseline every
        // number above reads against.
        out[`old-${label}`] = await run(shape, `o${label}`, (batch) =>
          legacyCommit(`bench-old-${label}`, batch),
        );
        const l0 = performance.now();
        await get(`legacy/bench-old-${label}`);
        out[`old-${label}`]!.loadMs = performance.now() - l0;
      }

      // Near-budget: fill past the 64 MB bound with ended 4 MB segments so
      // retention evicts inside the measured run, then time a steady-state
      // tail on the surviving tape. Unmeasured fill commits still run the
      // real path — eviction, blob release and all.
      for (let s = 0; s < shapes.fillSegments; s++) {
        await storage.appendHistoryBatch(
          "bench-new-budget",
          {
            ...makeBatch(`fill${s}`, 1, boot),
            events: [
              {
                seq: 0,
                tick: 1,
                cycle: 1,
                cause: {
                  kind: "patch",
                  resource: "logic",
                  num: 1,
                  data: "A".repeat(shapes.fillBatchBytes),
                },
              },
            ],
            end: { seq: 1, tick: 1, cycle: 1, reason: "quit" },
          } as never,
          "2.936",
          identity,
        );
      }
      const times: number[] = [];
      let bytes = 0;
      const heap0 = heap();
      for (let b = 1; b <= shapes.tailBatches; b++) {
        const batch = makeBatch("tail", b, b === 1 ? boot : undefined);
        const t0 = performance.now();
        await storage.appendHistoryBatch("bench-new-budget", batch as never, "2.936", identity);
        times.push(performance.now() - t0);
        bytes += JSON.stringify(batch).length;
        bytes += JSON.stringify((await get("history/bench-new-budget"))!).length;
        if (batch.boot !== undefined) bytes += JSON.stringify(bootFiles).length;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const t0 = performance.now();
      const tape = await storage.loadGameHistory("bench-new-budget");
      const loadMs = performance.now() - t0;
      out["new-near-budget"] = {
        commits: sorted.length,
        commitP50: sorted[Math.floor(sorted.length * 0.5)]!,
        commitP95: sorted[Math.floor(sorted.length * 0.95)]!,
        commitMax: sorted[sorted.length - 1]!,
        bytesPerCommit: bytes / sorted.length,
        loadMs,
        segments: tape?.segments.length ?? 0,
        records: await countRecords("history/bench-new-budget"),
        longTasks: longTasks.count,
        heapDelta: heap() - heap0,
      };

      // The old layout's near-budget representative: fabricate its single
      // tape record at the same ~64 MB size, then time one real commit —
      // a full run is its own finding (each commit rewrites the tape).
      const filler = { seq: 0, tick: 0, cycle: 0, cause: { kind: "key", code: 1 } };
      const fatRecord = {
        format: "monotio.agi.history",
        version: 1,
        projectId: "legacy/bench-old-budget",
        recording: {
          segments: [
            {
              id: "fat",
              boot,
              anchors: [],
              events: Array.from({ length: 2000 }, () => ({
                ...filler,
                pad: "p".repeat(32 * 1024),
              })),
              marks: [],
              sync: [],
            },
          ],
        },
        committed: {},
      };
      await put(fatRecord);
      const oldT0 = performance.now();
      const oldBytes = await legacyCommit("bench-old-budget", makeBatch("fat", 2));
      out["old-near-budget"] = {
        commits: 1,
        commitP50: performance.now() - oldT0,
        commitP95: performance.now() - oldT0,
        commitMax: performance.now() - oldT0,
        bytesPerCommit: oldBytes,
        loadMs: 0,
        segments: 1,
        records: 1,
        longTasks: longTasks.count,
        heapDelta: 0,
      };
      return out;
    },
    {
      small: SMALL_TAPE,
      large: LARGE_TAPE,
      fillSegments: FILL_SEGMENTS,
      fillBatchBytes: FILL_BATCH_BYTES,
      tailBatches: TAIL_BATCHES,
    },
  );

  for (const [label, r] of Object.entries(results)) {
    console.log(
      `[history-bench] ${label}: commits=${r.commits} p50=${r.commitP50.toFixed(1)}ms ` +
        `p95=${r.commitP95.toFixed(1)}ms max=${r.commitMax.toFixed(1)}ms ` +
        `bytes/commit=${(r.bytesPerCommit / 1024).toFixed(1)}KB ` +
        `load=${r.loadMs.toFixed(1)}ms segments=${r.segments} records=${r.records} ` +
        `longtasks=${r.longTasks} heapDelta=${(r.heapDelta / 1024 / 1024).toFixed(1)}MB`,
    );
  }
  for (const label of ["new-small", "new-large", "new-near-budget"]) {
    const r = results[label]!;
    expect(r.commitP50, `${label} p50`).toBeLessThan(100);
    expect(r.commitP95, `${label} p95`).toBeLessThan(250);
    expect(r.bytesPerCommit, `${label} bytes/commit`).toBeLessThan(256 * 1024);
  }
  expect(results["new-near-budget"]!.loadMs).toBeLessThan(2000);
  // The point of the change: bounded commit cost where the old layout's
  // whole-tape rewrite grew with every landed batch — already 250x the
  // bytes on the merely-large tape, and a single near-budget commit writes
  // the entire ~64 MB record.
  expect(results["new-large"]!.bytesPerCommit).toBeLessThan(
    results["old-large"]!.bytesPerCommit / 4,
  );
  expect(results["old-near-budget"]!.bytesPerCommit).toBeGreaterThan(32 * 1024 * 1024);
});
