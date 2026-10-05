import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rngDraw } from "../../src/runtime/rng.ts";
import { chromium } from "@playwright/test";
import { offlineSpectrogram } from "./offlineSpectrogram.ts";
import type * as OfflineMeasurements from "./offlineSpectrogram.ts";
import { startFixtureServer } from "./fixtureServerHarness.ts";
import { findFixture, fixtureSkip } from "../../test/fixtures.ts";
import { openContainer } from "../../src/container/container.ts";
import { parseSound, type SoundOutput } from "../../src/sound/sound.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { SOUND_LOOKAHEAD_SECONDS } from "../src/audio/soundTiming.ts";
import type { SoundTick } from "../src/audio/soundTiming.ts";

interface Boundary {
  time: number;
  voice: number;
  type: "start" | "end" | "rest" | "dma-off" | "source-end";
}

for (const query of ["pq1", "pq1-amiga", "sq2", "sq2-amiga", "sq2-iigs"]) {
  // PQ's cold boot starts SOUND 36, repeats 19, then plays SOUND 37 and 30.
  // Render the complete cold boot through
  // the shipped scheduler and browser audio graph, with no speaker device fallback.
  test(
    `${query} intro: note starts, ends and rests through the shipped audio graph`,
    {
      skip: fixtureSkip(query, query === "sq2-iigs" ? ["SIERRASTANDARD", "SQ2.SYS16"] : []),
    },
    async (t) => {
      const fixture = findFixture(query)!;
      const files = new Map<string, Uint8Array>();
      for (const actual of fixture.files.values()) {
        const path = join(fixture.dir, actual);
        if (statSync(path).isFile()) files.set(actual, new Uint8Array(readFileSync(path)));
      }
      const onsets: number[] = [];
      const sounds: { number: number; tick: number }[] = [];
      const boundaries: Boundary[] = [];
      let planned: Boundary[] = [];
      let tick = 0;
      let outputs: SoundOutput[] = [];
      let rngState = 1;
      const host: EngineHost = {
        randomByte() {
          const draw = rngDraw(rngState, () => 1);
          rngState = draw.state;
          return draw.byte;
        },
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
        soundOutput: (event) => outputs.push(event),
        soundTickOutput: (events) => outputs.push(...events),
        playSound(number, payload) {
          sounds.push({ number, tick });
          if (query === "sq2-iigs") return;
          planned = [];
          for (const [voice, channel] of parseSound(payload).channels.entries()) {
            let noteTick = tick + 1;
            for (const note of channel.notes) {
              if (noteTick >= 1800) break;
              if (voice < 3 && note.freqDivisor > 0 && note.attenuation < 15)
                onsets.push(SOUND_LOOKAHEAD_SECONDS + noteTick / 60);
              planned.push({
                time: SOUND_LOOKAHEAD_SECONDS + noteTick / 60,
                voice,
                type:
                  (voice === 3 || note.freqDivisor > 0) && note.attenuation < 15 ? "start" : "rest",
              });
              noteTick += note.duration;
              planned.push({ time: SOUND_LOOKAHEAD_SECONDS + noteTick / 60, voice, type: "end" });
            }
          }
        },
        stopSound() {
          planned = [];
        },
      };
      const engine = new Engine(openContainer(files), host, new Map());
      if (query === "pq1" || query === "sq2") engine.vars[22] = 3;
      const clock = new CycleClock(0);
      const packets: SoundTick[] = [];
      const iigsActive = new Set<number>();
      for (; tick < 1800; tick++) {
        outputs = [];
        engine.advanceClock(1000 / 60);
        engine.soundTick();
        const time = SOUND_LOOKAHEAD_SECONDS + tick / 60;
        boundaries.push(...planned.filter((boundary) => Math.abs(boundary.time - time) < 1e-8));
        if (
          engine.continuationPending ||
          engine.modalOpen ||
          clock.poll((tick * 1000) / 60, engine.vars[10]!)
        )
          engine.tick();
        for (const event of outputs) {
          if (event.kind === "paula" && event.period === null)
            boundaries.push({ time, voice: event.channel, type: "dma-off" });
          if (
            event.kind === "iigs" &&
            (event.event === "note-on" || event.event === "sample" || event.event === "note-off")
          )
            boundaries.push({
              time,
              voice: event.voice,
              type: event.event === "note-off" ? "end" : "start",
            });
          if (event.kind === "iigs") {
            if (event.event === "note-on" || event.event === "sample") iigsActive.add(event.voice);
            if (event.event === "note-off") iigsActive.delete(event.voice);
            if (event.event === "all-off") {
              for (const voice of iigsActive) boundaries.push({ time, voice, type: "end" });
              iigsActive.clear();
            }
          }
        }
        packets.push({ stream: "intro", tick, outputs, complete: false });
      }
      if (query === "pq1-amiga") {
        assert.equal(sounds[0]?.number, 36, "cold boot starts the publisher sound");
        assert.ok(
          sounds.some(({ number }) => number === 37),
          "the title tune plays",
        );
        assert.ok(
          sounds.some(({ number }) => number === 30),
          "the intro music starts within the capture",
        );
      }
      assert.ok(sounds.length > 0, "real LOGIC plays SOUND during the cold boot");
      const server = await startFixtureServer([]);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`${server.url}/`);
        const instrumentFiles =
          query === "sq2-iigs"
            ? Object.fromEntries(
                [...files]
                  .filter(
                    ([name]) =>
                      name.toUpperCase() === "SIERRASTANDARD" ||
                      name.toUpperCase().endsWith(".SYS16"),
                  )
                  .map(([name, bytes]) => [name, Array.from(bytes)]),
              )
            : {};
        const rendered = await page.evaluate(
          async ({ packets, boundaries, instrumentFiles }) => {
            const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
            const metricsPath = "/test/offlineSpectrogram.ts";
            const { boundaryMetrics, paulaReference } = (await import(
              metricsPath
            )) as typeof OfflineMeasurements;
            const { paulaRcCoefficients, paulaCouplingCoefficients, PAULA_LED_FILTER } =
              await import("/src/audio/paula.ts");
            const reference = packets.some((packet) =>
              packet.outputs.some((event) => event.kind === "paula"),
            )
              ? paulaReference(packets, 192000)
              : null;
            const renderReference = async (voice: number) => {
              const ctx = new OfflineAudioContext(1, 30 * 48000, 48000);
              const buffer = ctx.createBuffer(1, 30 * 192000, 192000);
              buffer.getChannelData(0).set(reference![voice]!);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              const coefficients = paulaRcCoefficients(48000);
              const rc = ctx.createIIRFilter(coefficients.feedforward, coefficients.feedback);
              const led = ctx.createBiquadFilter();
              led.type = "lowpass";
              led.frequency.value = PAULA_LED_FILTER.frequency;
              led.Q.value = 20 * Math.log10(PAULA_LED_FILTER.q);
              const coupling = paulaCouplingCoefficients(48000);
              const ac = ctx.createIIRFilter(coupling.feedforward, coupling.feedback);
              const mono = ctx.createGain();
              mono.gain.value = 0.5;
              source.connect(rc);
              rc.connect(led);
              led.connect(ac);
              ac.connect(mono);
              mono.connect(ctx.destination);
              source.start();
              return Array.from((await ctx.startRendering()).getChannelData(0));
            };
            const render = async (voice: number | null) => {
              const originalRandom = Math.random;
              let state = 1;
              Math.random = () => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state / 4294967296;
              };
              const ctx = new OfflineAudioContext(1, 30 * 48000, 48000);
              const sourceEnds: { at: number }[] = [];
              const createSource = ctx.createBufferSource.bind(ctx);
              ctx.createBufferSource = () => {
                const source = createSource();
                const end = { at: Infinity };
                sourceEnds.push(end);
                const start = source.start.bind(source);
                const stop = source.stop.bind(source);
                source.start = (at = 0, offset = 0) => {
                  if (!source.loop && source.buffer)
                    end.at = at + (source.buffer.duration - offset) / source.playbackRate.value;
                  start(at, offset);
                };
                source.stop = (at = 0) => {
                  end.at = Math.min(end.at, at);
                  stop(at);
                };
                return source;
              };
              const audio = new AgiAudio({
                volume: 1,
                contextFactory: () => ctx as unknown as AudioContext,
              });
              audio.useGameFiles(
                Object.fromEntries(
                  Object.entries(instrumentFiles).map(([name, bytes]) => [
                    name,
                    new Uint8Array(bytes),
                  ]),
                ),
              );
              if (Object.keys(instrumentFiles).length && !audio.iigsInstruments)
                throw new Error("IIgs bank did not load");
              for (let lane = 0; lane < 4; lane++)
                audio.setLaneAudible(lane, voice === null || lane === voice);
              for (const packet of packets)
                audio.outputTick({
                  ...packet,
                  outputs: packet.outputs.filter(
                    (event) =>
                      voice === null ||
                      event.kind !== "iigs" ||
                      !("voice" in event) ||
                      event.voice === voice,
                  ),
                });
              const buffer = await ctx.startRendering();
              Math.random = originalRandom;
              return {
                pcm: Array.from(buffer.getChannelData(0)),
                ends: sourceEnds.map((end) => end.at).filter(Number.isFinite),
              };
            };
            const samples = (await render(null)).pcm;
            const measurements = [];
            const voices = [];
            for (const voice of new Set(boundaries.map((boundary) => boundary.voice))) {
              const laneRender = await render(voice);
              const pcm = laneRender.pcm;
              const expected = reference ? await renderReference(voice) : null;
              voices.push({
                voice,
                dc: pcm.reduce((sum, x) => sum + x, 0) / pcm.length,
                rms: Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length),
              });
              const lane: Boundary[] = boundaries.filter((boundary) => boundary.voice === voice);
              if (Object.keys(instrumentFiles).length)
                for (const time of new Set(laneRender.ends))
                  lane.push({ time, voice, type: "source-end" });
              lane.sort((a, b) => a.time - b.time);
              for (const boundary of lane.filter((boundary) => boundary.time < 29.975)) {
                const next = lane.find((other) => other.time > boundary.time + 1e-8);
                const steadyAt =
                  boundary.type === "start" && next
                    ? (boundary.time + next.time) / 2
                    : boundary.time - 0.025;
                const measured = boundaryMetrics(pcm, boundary.time, 48000, steadyAt);
                const hardware = expected
                  ? boundaryMetrics(expected, boundary.time, 48000, steadyAt)
                  : null;
                measurements.push({
                  ...boundary,
                  steadyAt,
                  ...measured,
                  hardware,
                  stepError: hardware ? Math.abs(measured.step - hardware.step) : null,
                });
              }
            }
            return { samples, measurements, voices };
          },
          { packets, boundaries, instrumentFiles },
        );
        const { samples, measurements, voices } = rendered;
        // First 4 ms: differences measure discontinuities; a short DFT measures
        // onset energy above 8 kHz, well beyond the tone fundamentals in SOUND 36.
        let maxJump = 0;
        let largeJumps = 0;
        let highEnergy = 0;
        let totalEnergy = 0;
        for (const onset of onsets) {
          const start = Math.round(onset * 48000);
          const size = 192;
          for (let i = start; i < start + size; i++) {
            const jump = Math.abs(samples[i]! - samples[i - 1]!);
            maxJump = Math.max(maxJump, jump);
            if (jump > 0.08) largeJumps++;
          }
          for (let k = 1; k < size / 2; k++) {
            let re = 0;
            let im = 0;
            for (let n = 0; n < size; n++) {
              const x =
                samples[start + n]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
              re += x * Math.cos((2 * Math.PI * k * n) / size);
              im -= x * Math.sin((2 * Math.PI * k * n) / size);
            }
            const energy = re * re + im * im;
            totalEnergy += energy;
            if ((k * 48000) / size >= 8000) highEnergy += energy;
          }
        }
        const metrics = {
          onsetCount: onsets.length,
          maxJump,
          largeJumps,
          highEnergy,
          highFraction: highEnergy / totalEnergy,
          packetsSha256: createHash("sha256").update(JSON.stringify(packets)).digest("hex"),
          backend: packets
            .flatMap((packet) => packet.outputs)
            .find((event) => event.kind !== "speaker")?.kind,
          boundaryCount: measurements.length,
          maxStep: Math.max(...measurements.map((m) => m.step)),
          maxLowEnergy: Math.max(...measurements.map((m) => m.lowEnergy)),
          maxExcessLowEnergy: Math.max(...measurements.map((m) => m.excessLowEnergy)),
          maxVoiceDc: Math.max(...measurements.map((m) => Math.abs(m.voiceDc))),
          maxBoundaryJump: Math.max(...measurements.map((m) => m.maxJump)),
          peak: samples.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0),
          rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length),
        };
        t.diagnostic(JSON.stringify(metrics));
        // Explicit opt-in output belongs to this render test. Game PCM stays private.
        const output = process.env["AGI_AUDIO_RENDER_DIR"];
        if (output) {
          mkdirSync(output, { recursive: true });
          const wav = Buffer.alloc(44 + samples.length * 4);
          wav.write("RIFF", 0);
          wav.writeUInt32LE(wav.length - 8, 4);
          wav.write("WAVEfmt ", 8);
          wav.writeUInt32LE(16, 16);
          wav.writeUInt16LE(3, 20);
          wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(48000, 24);
          wav.writeUInt32LE(192000, 28);
          wav.writeUInt16LE(4, 32);
          wav.writeUInt16LE(32, 34);
          wav.write("data", 36);
          wav.writeUInt32LE(samples.length * 4, 40);
          for (let i = 0; i < samples.length; i++) wav.writeFloatLE(samples[i]!, 44 + i * 4);
          writeFileSync(join(output, `${query}-intro.wav`), wav);
          writeFileSync(
            join(output, `${query}-spectrogram.png`),
            await offlineSpectrogram(page, samples),
          );
          writeFileSync(
            join(output, `${query}-metrics.json`),
            JSON.stringify({ ...metrics, onsets, sounds, voices, measurements }, null, 2),
          );
        }
        assert.ok(
          measurements.some((m) => m.type === "start"),
          "capture covers note starts",
        );
        assert.ok(
          measurements.some((m) => m.type === "end"),
          "capture covers note ends",
        );
        if (query === "sq2-iigs") {
          assert.ok(metrics.peak <= 1, `DOC mix peak ${metrics.peak} exceeds full scale`);
          assert.ok(metrics.rms > 0, "SQ2 intro produces audible DOC output");
        }
        if (query === "pq1-amiga") {
          assert.ok(onsets.length > 50, "the render exercises repeated tone onsets");
          assert.ok(maxJump < 0.08, `onset discontinuity ${maxJump}`);
          // Compare the step to a separate held-byte DAC, rather than bounding
          // the real tone harmonics and envelope attacks as if they were clicks.
          const offError = Math.max(
            ...measurements.filter((m) => m.type === "dma-off").map((m) => m.stepError ?? 0),
          );
          const restError = Math.max(
            ...measurements.filter((m) => m.type === "rest").map((m) => m.stepError ?? 0),
          );
          // One signed DAC LSB at full voice gain, downmixed from one stereo side.
          const lsb = 0.4 / 128 / 2;
          assert.ok(offError < lsb, `DMA-off step error ${offError} exceeds one output DAC LSB`);
          assert.ok(
            restError < 2 * lsb,
            `rest step error ${restError} exceeds two output DAC LSBs`,
          );
        }
      } finally {
        await browser.close();
        await server.close();
      }
    },
  );
}
