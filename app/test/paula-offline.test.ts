import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rngDraw } from "../../src/runtime/rng.ts";
import { chromium } from "@playwright/test";
import { offlineSpectrogram } from "./offlineSpectrogram.ts";
import { startFixtureServer } from "./fixtureServerHarness.ts";
import { findFixture, fixtureSkip } from "../../test/fixtures.ts";
import { openContainer } from "../../src/container/container.ts";
import { parseSound, type SoundOutput } from "../../src/sound/sound.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { SOUND_LOOKAHEAD_SECONDS } from "../src/audio/soundTiming.ts";

// PQ's cold boot starts SOUND 36, repeats 19, then plays SOUND 37 and 30.
// Render the complete cold boot through
// the shipped scheduler and browser audio graph, with no speaker device fallback.
test(
  "PQ Amiga intro: Paula onsets stay within the A500 output bandwidth",
  {
    skip: fixtureSkip("pq1-amiga"),
  },
  async (t) => {
    const fixture = findFixture("pq1-amiga")!;
    const files = new Map<string, Uint8Array>();
    for (const actual of fixture.files.values()) {
      const path = join(fixture.dir, actual);
      if (statSync(path).isFile()) files.set(actual, new Uint8Array(readFileSync(path)));
    }
    const onsets: number[] = [];
    const sounds: { number: number; tick: number }[] = [];
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
        for (const channel of parseSound(payload).channels.slice(0, 3)) {
          let noteTick = tick + 1;
          for (const note of channel.notes) {
            if (noteTick >= 1800) break;
            if (note.freqDivisor > 0 && note.attenuation < 15)
              onsets.push(SOUND_LOOKAHEAD_SECONDS + noteTick / 60);
            noteTick += note.duration;
          }
        }
      },
    };
    const engine = new Engine(openContainer(files), host, new Map(), { profile: "amiga-2.310" });
    const clock = new CycleClock(0);
    const packets = [];
    for (; tick < 1800; tick++) {
      outputs = [];
      engine.advanceClock(1000 / 60);
      engine.soundTick();
      if (
        engine.continuationPending ||
        engine.modalOpen ||
        clock.poll((tick * 1000) / 60, engine.vars[10]!)
      )
        engine.tick();
      packets.push({ stream: "intro", tick, outputs, complete: false });
    }
    assert.equal(sounds[0]?.number, 36, "cold boot starts the publisher sound");
    assert.ok(
      sounds.some(({ number }) => number === 37),
      "the title tune plays",
    );
    assert.ok(
      sounds.some(({ number }) => number === 30),
      "the intro music starts within the capture",
    );
    const server = await startFixtureServer([]);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.url}/`);
      const samples = await page.evaluate(async (packets) => {
        const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
        const ctx = new OfflineAudioContext(1, 30 * 48000, 48000);
        const audio = new AgiAudio({
          volume: 1,
          contextFactory: () => ctx as unknown as AudioContext,
        });
        for (const packet of packets) audio.outputTick(packet);
        const buffer = await ctx.startRendering();
        return Array.from(buffer.getChannelData(0));
      }, packets);
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
            const x = samples[start + n]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
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
      };
      t.diagnostic(JSON.stringify(metrics));
      // Explicit opt-in output belongs to this render test. Game PCM stays private.
      const output = process.env["AGI_AUDIO_RENDER_DIR"];
      if (output) {
        mkdirSync(output, { recursive: true });
        const wav = Buffer.alloc(44 + samples.length * 2);
        wav.write("RIFF", 0);
        wav.writeUInt32LE(wav.length - 8, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(48000, 24);
        wav.writeUInt32LE(96000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(samples.length * 2, 40);
        for (let i = 0; i < samples.length; i++)
          wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
        writeFileSync(join(output, "intro.wav"), wav);
        writeFileSync(join(output, "spectrogram.png"), await offlineSpectrogram(page, samples));
        writeFileSync(
          join(output, "metrics.json"),
          JSON.stringify({ ...metrics, onsets, sounds }, null, 2),
        );
      }
      assert.ok(onsets.length > 50, "the render exercises repeated tone onsets");
      assert.ok(maxJump < 0.08, `onset discontinuity ${maxJump}`);
      assert.ok(
        highEnergy / totalEnergy < 0.000001,
        `wideband onset fraction ${highEnergy / totalEnergy}`,
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
