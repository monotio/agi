import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_CATALOG } from "../src/gameCatalog.ts";
import type { LibraryMetadata } from "../src/gameMetadata.ts";
import { checkLessonKeep, type LessonSession } from "../src/lessons/lessonCheck.ts";
import {
  createLessonBadges,
  LESSONS_STORAGE_KEY,
  readCompletedLessons,
  readFoldedCards,
  setCardFolded,
} from "../src/lessons/lessonStorage.ts";
import { LESSON_RELEASES, lessonCatalogId, lessonSetFor } from "../src/lessons/registry.ts";
import type { LessonVerifyInput, StudioLesson } from "../src/lessons/types.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const PROFILE = PROFILES["2.936"]!;

// ---- registry ---------------------------------------------------------------

const TUTORIAL_1_1 = { id: "adventure-department", version: "1.1.0" };

test("lesson sets are found by catalog release: id and version", async () => {
  const set = await lessonSetFor(TUTORIAL_1_1);
  assert.ok(set, "the tutorial registers a lesson set");
  assert.equal(set.catalogId, "adventure-department");
  assert.equal(set.lessons.length, 3);
  // The 1.0 release stays in players' libraries; these lessons verify 1.1 resources.
  assert.equal(await lessonSetFor({ id: "adventure-department", version: "1.0.0" }), undefined);
  assert.equal(await lessonSetFor({ id: "kings-quest-1", version: "1.1.0" }), undefined);
  assert.equal(await lessonSetFor(undefined), undefined);
  // A prototype key is not a registered catalog id.
  assert.equal(await lessonSetFor({ id: "constructor", version: "1.1.0" }), undefined);
  assert.equal(await lessonSetFor({ id: "__proto__", version: "1.1.0" }), undefined);
});

test("every registered release names a catalog release and loads the set written for it", async () => {
  for (const release of LESSON_RELEASES) {
    const set = await release.load();
    assert.deepEqual(
      { id: set.catalogId, version: set.version },
      { id: release.id, version: release.version },
    );
    assert.ok(
      GAME_CATALOG.some((entry) => entry.id === release.id && entry.version === release.version),
      `${release.id} ${release.version} is a catalog release: re-verify its lessons on a version bump`,
    );
  }
});

test("every registered lesson has a unique id, 2-4 steps and a target", async () => {
  for (const release of LESSON_RELEASES) {
    const set = await release.load();
    const ids = set.lessons.map((lesson) => lesson.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const lesson of set.lessons) {
      assert.ok(lesson.steps.length >= 2 && lesson.steps.length <= 4, lesson.id);
      assert.ok(lesson.open.studio === "room" || lesson.open.studio === "sprite", lesson.id);
    }
  }
});

const library = (patch: Partial<LibraryMetadata>) => ({ library: patch as LibraryMetadata });

test("a game's lesson release is its catalog release, or its remix chain's", () => {
  const records: Record<string, ReturnType<typeof library>> = {
    "catalog-adventure-department-1.1.0": library({
      source: "catalog",
      catalog: { id: "adventure-department", version: "1.1.0" },
    }),
    "catalog-adventure-department-1.0.0": library({
      source: "catalog",
      catalog: { id: "adventure-department", version: "1.0.0" },
    }),
    "remix-a": library({
      source: "remix",
      parent: { project: "catalog-adventure-department-1.1.0" } as LibraryMetadata["parent"],
    }),
    "remix-b": library({
      source: "remix",
      parent: { project: "remix-a" } as LibraryMetadata["parent"],
    }),
    "remix-old": library({
      source: "remix",
      parent: { project: "catalog-adventure-department-1.0.0" } as LibraryMetadata["parent"],
    }),
    "loop-a": library({ source: "remix", parent: { project: "loop-b" } as never }),
    "loop-b": library({ source: "remix", parent: { project: "loop-a" } as never }),
    "zip-game": library({ source: "zip" }),
  };
  const meta = (id: string) => records[id] ?? null;
  const OLD = { id: "adventure-department", version: "1.0.0" };
  assert.deepEqual(lessonCatalogId("catalog-adventure-department-1.1.0", meta), TUTORIAL_1_1);
  assert.deepEqual(lessonCatalogId("remix-a", meta), TUTORIAL_1_1);
  assert.deepEqual(lessonCatalogId("remix-b", meta), TUTORIAL_1_1);
  assert.deepEqual(lessonCatalogId("catalog-adventure-department-1.0.0", meta), OLD);
  assert.deepEqual(lessonCatalogId("remix-old", meta), OLD, "a 1.0 remix keeps its release");
  assert.equal(lessonCatalogId("zip-game", meta), undefined);
  assert.equal(lessonCatalogId("loop-a", meta), undefined, "a parent cycle ends");
  assert.equal(lessonCatalogId("missing", meta), undefined);
  assert.equal(lessonCatalogId(undefined, meta), undefined);
});

// ---- badge storage ----------------------------------------------------------

test("a badge is stored as { version: 1, completed } and read back", () => {
  const storage = memoryStorage();
  const badges = createLessonBadges(storage);
  assert.deepEqual([...badges.completed.value], []);
  badges.award("ad-gallery-recipe");
  badges.award("ad-gallery-recipe");
  assert.deepEqual(JSON.parse(storage.data.get(LESSONS_STORAGE_KEY)!), {
    version: 1,
    completed: ["ad-gallery-recipe"],
  });
  assert.deepEqual([...badges.completed.value], ["ad-gallery-recipe"]);
  // The next page load sees it.
  assert.deepEqual([...readCompletedLessons(storage)], ["ad-gallery-recipe"]);
  badges.award("ad-robot-flipbook");
  assert.deepEqual(JSON.parse(storage.data.get(LESSONS_STORAGE_KEY)!).completed, [
    "ad-gallery-recipe",
    "ad-robot-flipbook",
  ]);
});

test("an unknown badge record version is ignored and never rewritten", () => {
  const future = JSON.stringify({ version: 2, completed: ["a"], extra: true });
  const storage = memoryStorage({ [LESSONS_STORAGE_KEY]: future });
  assert.deepEqual([...readCompletedLessons(storage)], []);
  const badges = createLessonBadges(storage);
  badges.award("ad-gallery-recipe");
  assert.equal(storage.data.get(LESSONS_STORAGE_KEY), future);
  // This page still shows the badge it just earned.
  assert.deepEqual([...badges.completed.value], ["ad-gallery-recipe"]);

  for (const raw of ["not json", "[]", '{"version":1,"completed":"a"}']) {
    const other = memoryStorage({ [LESSONS_STORAGE_KEY]: raw });
    assert.deepEqual([...readCompletedLessons(other)], []);
    createLessonBadges(other).award("x");
    assert.equal(other.data.get(LESSONS_STORAGE_KEY), raw, raw);
  }
  // Non-string entries of a version-1 record are dropped on read.
  const mixed = memoryStorage({
    [LESSONS_STORAGE_KEY]: JSON.stringify({ version: 1, completed: ["a", 3, null] }),
  });
  assert.deepEqual([...readCompletedLessons(mixed)], ["a"]);
});

test("a folded card is stored as { version: 1, folded }; another record is never rewritten", () => {
  const CARDS = "monotio_agi.lessonCards";
  const storage = memoryStorage();
  setCardFolded("ad-gallery-recipe", true, storage);
  setCardFolded("ad-robot-flipbook", true, storage);
  setCardFolded("ad-gallery-recipe", false, storage);
  assert.deepEqual(JSON.parse(storage.data.get(CARDS)!), {
    version: 1,
    folded: ["ad-robot-flipbook"],
  });
  assert.deepEqual([...readFoldedCards(storage)], ["ad-robot-flipbook"]);
  for (const raw of [JSON.stringify({ version: 2, folded: ["a"] }), '["a"]', "not json"]) {
    const other = memoryStorage({ [CARDS]: raw });
    assert.deepEqual([...readFoldedCards(other)], [], raw);
    setCardFolded("x", true, other);
    assert.equal(other.data.get(CARDS), raw, raw);
  }
});

test("blocked storage neither throws nor loses this page's badge", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual([...readCompletedLessons(blocked)], []);
  const badges = createLessonBadges(blocked);
  badges.award("ad-gallery-recipe");
  assert.deepEqual([...badges.completed.value], ["ad-gallery-recipe"]);
});

// ---- the verify hook ----------------------------------------------------------

function session(verify?: NonNullable<StudioLesson["challenge"]>["verify"]): LessonSession {
  return {
    lesson: {
      id: "demo",
      title: "Move the sun",
      teaser: "",
      steps: ["a", "b"],
      open: { studio: "room", picture: 1 },
      ...(verify ? { challenge: { prompt: "Move the sun.", verify } } : {}),
    },
    before: Uint8Array.of(1, 2),
    beforeSource: "before",
  };
}

const kept = {
  kind: "picture" as const,
  num: 1,
  after: Uint8Array.of(3),
  afterSource: "after",
  profile: PROFILE,
};

test("a satisfied challenge awards its badge with a success line", () => {
  const seen: LessonVerifyInput[] = [];
  const awarded: string[] = [];
  const outcome = checkLessonKeep(
    session((input) => (seen.push(input), { ok: true })),
    kept,
    (id) => awarded.push(id),
  );
  assert.deepEqual(outcome, { ok: true, message: "Challenge complete: Move the sun." });
  assert.deepEqual(awarded, ["demo"]);
  assert.deepEqual(seen, [
    {
      kind: "picture",
      num: 1,
      before: Uint8Array.of(1, 2),
      after: Uint8Array.of(3),
      beforeSource: "before",
      afterSource: "after",
      profile: PROFILE,
    },
  ]);
});

test("an unsatisfied challenge shows its hint and awards nothing", () => {
  const awarded: string[] = [];
  assert.deepEqual(
    checkLessonKeep(
      session(() => ({ ok: false, hint: "The sun has not moved yet." })),
      kept,
      (id) => awarded.push(id),
    ),
    { ok: false, message: "The sun has not moved yet." },
  );
  assert.deepEqual(
    checkLessonKeep(
      session(() => ({ ok: false })),
      kept,
      (id) => awarded.push(id),
    ),
    { ok: false, message: "Not quite yet: Move the sun." },
  );
  assert.deepEqual(awarded, []);
});

test("a throwing check awards nothing and never escapes the Keep", () => {
  const awarded: string[] = [];
  const outcome = checkLessonKeep(
    session(() => {
      throw new Error("boom");
    }),
    kept,
    (id) => awarded.push(id),
  );
  assert.equal(outcome?.ok, false);
  assert.match(outcome!.message, /could not check/);
  assert.deepEqual(awarded, []);
});

test("no challenge, or a keep of another resource, checks nothing", () => {
  const awarded: string[] = [];
  let calls = 0;
  const verify = () => (calls++, { ok: true });
  assert.equal(
    checkLessonKeep(session(), kept, (id) => awarded.push(id)),
    null,
  );
  assert.equal(
    checkLessonKeep(session(verify), { ...kept, num: 2 }, (id) => awarded.push(id)),
    null,
  );
  assert.equal(
    checkLessonKeep(session(verify), { ...kept, kind: "view" }, (id) => awarded.push(id)),
    null,
  );
  assert.equal(calls, 0);
  assert.deepEqual(awarded, []);
});
