import assert from "node:assert/strict";
import test from "node:test";
import { useTransport, type TransportMark, type TransportSource } from "../src/useTransport.ts";

function makeSource(marks: TransportMark[]) {
  const calls = { seeks: [] as number[], marks: [] as TransportMark[] };
  const source: TransportSource = {
    tick: 0,
    totalTicks: 10_000,
    seeking: false,
    playing: false,
    speed: 1,
    marks,
    seekTick: (tick) => calls.seeks.push(tick),
    togglePlay: () => {},
    setSpeed: () => {},
    setScrubbing: () => {},
    step: () => {},
    clickMark: (mark) => calls.marks.push(mark),
  };
  return { source, calls };
}

const extras = {
  visible: true,
  controls: true,
  loadingText: undefined,
  testid: "t",
  timelineTestid: "t",
  timelineLabel: "t",
  fillTestid: "t",
  thumbTestid: "t",
  markerClass: "m",
  tooltipClass: "tt",
  play: { testid: "t", icon: "play" as const, title: "", aria: "", disabled: false, run: () => {} },
  speedGroup: false,
  live: undefined,
  speedTestid: "t",
  speedActiveClass: "a",
  speedTitle: () => "",
  readout: undefined,
  posTestid: undefined,
  dropped: 0,
  trailing: [],
  storyPause: undefined,
  pending: undefined,
  errors: [],
};

test("scrubDown near a mark clicks the mark instead of seeking the raw percent", () => {
  const mark = { key: 1, percent: 7.35, label: "Bellevue" };
  const { source, calls } = makeSource([mark]);
  const model = useTransport(source, extras);

  model.scrubDown(7.0); // within MARK_SNAP_PERCENT (4%)

  assert.deepEqual(calls.marks, [mark]);
  assert.deepEqual(calls.seeks, []);
  assert.equal(model.scrubPercent, mark.percent);
});

test("scrubDown resolves the nearest mark when dense marks overlap", () => {
  // The mh1 cluster that made Bellevue's DOM marker unclickable.
  const cityMap = { key: 1, percent: 7.18, label: "City map" };
  const bellevue = { key: 2, percent: 7.35, label: "Bellevue" };
  const mad = { key: 3, percent: 7.78, label: "Consult the MAD" };
  const { source, calls } = makeSource([cityMap, bellevue, mad]);
  const model = useTransport(source, extras);

  model.scrubDown(7.3);

  assert.deepEqual(calls.marks, [bellevue]);
});

test("scrubDown far from any mark seeks the raw position", () => {
  const { source, calls } = makeSource([{ key: 1, percent: 50, label: "mid" }]);
  const model = useTransport(source, extras);

  model.scrubDown(20);

  assert.deepEqual(calls.marks, []);
  assert.deepEqual(calls.seeks, [2000]);
});
