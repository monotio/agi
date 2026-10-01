import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readToursSeen,
  STUDIO_TOUR_KEY,
  STUDIO_TOURS,
  useStudioTour,
} from "../src/studio/useStudioTour.ts";

/**
 * The Studios' first-run tour: which Studios this viewer has toured, kept as
 * `{ version: 1, seen: [...] }` under `monotio_agi.studioTour`; when the tour
 * offers itself (once per Studio, never while a lesson's card is open); and
 * the replay path from the key sheet or the lesson card.
 */

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const blockedStorage = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("SecurityError");
  },
};

const stored = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.data.get(STUDIO_TOUR_KEY) ?? "null") as unknown;

/** Walk a shown tour to its end with Next, then Done. */
function finish(tour: ReturnType<typeof useStudioTour>): void {
  while (tour.step.value !== null && tour.step.value < tour.marks.length - 1) tour.next();
  tour.next();
}

test("each Studio has three marks, each with a title, one line of text and an anchor", () => {
  for (const studio of ["room", "sprite"] as const) {
    const marks = STUDIO_TOURS[studio];
    assert.equal(marks.length, 3, studio);
    for (const mark of marks) {
      assert.ok(mark.title.length > 0 && mark.title.length <= 30, mark.title);
      assert.ok(mark.body.length > 0 && mark.body.length <= 140, mark.body);
      assert.ok(mark.anchors.length > 0, mark.title);
      assert.ok(mark.anchors.includes(mark.place), `${mark.title} sits beside one of its anchors`);
    }
    assert.equal(marks.at(-1)?.place, "studio-keep", "the last mark shows Keep");
  }
  assert.equal(STUDIO_TOURS.room[0]?.place, "studio-lens");
  assert.equal(STUDIO_TOURS.sprite[0]?.place, "sprite-timeline");
  assert.equal(STUDIO_TOURS.sprite[1]?.place, "sprite-palette");
});

test("storage: a version-1 record lists the Studios seen; anything else reads as none", () => {
  assert.deepEqual([...readToursSeen(memoryStorage())], []);
  assert.deepEqual(
    [
      ...readToursSeen(
        memoryStorage({ [STUDIO_TOUR_KEY]: JSON.stringify({ version: 1, seen: ["room", 7] }) }),
      ),
    ],
    ["room"],
  );
  for (const raw of [
    JSON.stringify({ version: 2, seen: ["room"] }),
    JSON.stringify({ seen: ["room"] }),
    JSON.stringify(["room"]),
    "not json",
  ])
    assert.deepEqual([...readToursSeen(memoryStorage({ [STUDIO_TOUR_KEY]: raw }))], [], raw);
  assert.deepEqual([...readToursSeen(blockedStorage)], []);
  assert.deepEqual([...readToursSeen(undefined)], []);
});

test("the first open shows mark 1; Next, Next, Done marks that Studio seen and only it", () => {
  const storage = memoryStorage();
  const tour = useStudioTour("room", { lesson: () => false, storage });
  assert.equal(tour.step.value, null);
  assert.equal(tour.offer(), true);
  assert.equal(tour.step.value, 0);
  assert.equal(tour.mark.value?.title, "Lenses");
  tour.next();
  assert.equal(tour.mark.value?.title, "Items");
  tour.next();
  assert.equal(tour.mark.value?.title, "Save");
  assert.equal(tour.last.value, true);
  assert.equal(storage.data.has(STUDIO_TOUR_KEY), false, "nothing is stored before the end");
  tour.next();
  assert.equal(tour.step.value, null);
  assert.deepEqual(stored(storage), { version: 1, seen: ["room"] });

  // Reopening the Room Studio offers nothing; Sprite Studio has its own tour.
  const again = useStudioTour("room", { lesson: () => false, storage });
  assert.equal(again.offer(), false);
  assert.equal(again.step.value, null);
  const sprite = useStudioTour("sprite", { lesson: () => false, storage });
  assert.equal(sprite.offer(), true);
  assert.equal(sprite.mark.value?.title, "Loops and cels");
  sprite.end();
  assert.deepEqual(stored(storage), { version: 1, seen: ["room", "sprite"] });
});

test("Skip (or Esc) on any mark marks the Studio seen", () => {
  const storage = memoryStorage();
  const tour = useStudioTour("sprite", { lesson: () => false, storage });
  tour.offer();
  tour.next();
  tour.end();
  assert.equal(tour.step.value, null);
  assert.deepEqual(stored(storage), { version: 1, seen: ["sprite"] });
  assert.equal(useStudioTour("sprite", { lesson: () => false, storage }).offer(), false);
});

test("a lesson's card keeps the tour silent and never marks it seen", () => {
  const storage = memoryStorage();
  let lesson = true;
  const tour = useStudioTour("room", { lesson: () => lesson, storage });
  assert.equal(tour.offer(), false, "silent while the Try this card is open");
  assert.equal(tour.step.value, null);

  // The card's "30-second tour" link starts it by hand; ending it stores nothing.
  tour.start();
  assert.equal(tour.step.value, 0);
  finish(tour);
  assert.equal(tour.step.value, null);
  tour.start();
  tour.end();
  assert.equal(storage.data.has(STUDIO_TOUR_KEY), false);

  // The first free visit still gets the tour.
  lesson = false;
  assert.equal(useStudioTour("room", { lesson: () => lesson, storage }).offer(), true);
});

test("replay: the key sheet's Tour starts at mark 1 after the tour was seen", () => {
  const storage = memoryStorage({
    [STUDIO_TOUR_KEY]: JSON.stringify({ version: 1, seen: ["room", "sprite"] }),
  });
  const tour = useStudioTour("room", { lesson: () => false, storage });
  assert.equal(tour.offer(), false);
  tour.start();
  assert.equal(tour.step.value, 0);
  tour.next();
  tour.start();
  assert.equal(tour.step.value, 0, "a replay always starts at the first mark");
  finish(tour);
  assert.deepEqual(stored(storage), { version: 1, seen: ["room", "sprite"] });
});

test("a record from another version is ignored and never rewritten", () => {
  const future = JSON.stringify({ version: 2, seen: { room: 3 } });
  const storage = memoryStorage({ [STUDIO_TOUR_KEY]: future });
  const tour = useStudioTour("room", { lesson: () => false, storage });
  assert.equal(tour.offer(), true);
  tour.end();
  assert.equal(storage.data.get(STUDIO_TOUR_KEY), future);
});

test("blocked storage: the tour still runs and ends without throwing", () => {
  const tour = useStudioTour("room", { lesson: () => false, storage: blockedStorage });
  assert.equal(tour.offer(), true);
  finish(tour);
  assert.equal(tour.step.value, null);
});
