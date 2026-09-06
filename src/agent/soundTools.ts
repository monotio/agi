/** Compact, bounded authoring and inspection helpers for authentic AGI sounds. */
import { resourceRevision } from "./authoringState.ts";
import {
  buildSound,
  midiToAgiDivisor,
  parseNoteToMidi,
  type AgentSessionState,
  type AgentToolResult,
  type SoundNoteInput,
  type SoundTrackInput,
  type ToolDefinition,
} from "./tools.ts";
import { parseSound } from "../sound/sound.ts";
import { renderSoundPreview } from "../sound/preview.ts";
import { soundFeedback, type SoundFeedbackOptions } from "./soundFeedback.ts";

const CHANNELS = ["melody", "harmony", "bass", "noise"] as const;
type ChannelName = (typeof CHANNELS)[number];

const CHANNEL_INDEX: Record<ChannelName, number> = {
  melody: 0,
  harmony: 1,
  bass: 2,
  noise: 3,
};

const NOISE_SELECTORS: Record<string, number> = {
  "periodic-low": 2,
  "periodic-medium": 1,
  "periodic-high": 0,
  "white-low": 6,
  "white-medium": 5,
  "white-high": 4,
};

const REST_NAMES = new Set(["rest", "r", "silence"]);
const MAX_EXPANDED_NOTES = 4096;

/** Strict-compatible schemas for compact music writing and bounded sound reading. */
export const SOUND_TOOLS: readonly ToolDefinition[] = [
  {
    name: "write_music",
    description:
      "Compile beat-based music to four-channel AGI SOUND `num` at `tempo` BPM from `tracks`. Roles map to melody=0, harmony=1, bass=2, noise=3. Tone notes use names; noise uses periodic/white low/medium/high. Volume 15 is loudest. Repeats expand to at most 4096 events.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          minimum: 0,
          maximum: 255,
        },
        tempo: {
          type: "number",
          minimum: 40,
          maximum: 240,
        },
        tracks: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: {
                type: "string",
                enum: CHANNELS,
              },
              volume: {
                type: "integer",
                minimum: 0,
                maximum: 15,
              },
              events: {
                type: "array",
                minItems: 1,
                maxItems: MAX_EXPANDED_NOTES,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    note: {
                      type: ["string", "null"],
                      maxLength: 32,
                    },
                    beats: {
                      type: "number",
                      exclusiveMinimum: 0,
                      maximum: 16,
                    },
                    repeat: {
                      type: "integer",
                      minimum: 1,
                      maximum: 32,
                    },
                  },
                  required: ["note", "beats", "repeat"],
                },
              },
            },
            required: ["channel", "volume", "events"],
          },
        },
      },
      required: ["num", "tempo", "tracks"],
    },
  },
  {
    name: "read_sound",
    description:
      "Inspect SOUND `num` as timed events and a four-channel timeline; null `channel` reads all. `representation` auto uses saved music intent when available; choose music for estimated pitches or sound for raw frequency/noise. Seconds and divisors are authoritative. `offset` and `limit` page the events; follow `nextOffset`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          minimum: 0,
          maximum: 255,
        },
        channel: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 3,
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 65535,
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 64,
        },
        representation: {
          type: ["string", "null"],
          enum: ["auto", "music", "sound", null],
        },
      },
      required: ["num", "channel", "offset", "limit", "representation"],
    },
  },
  {
    name: "preview_sound",
    description:
      "Render a bounded WAV preview of SOUND `num` from `startSeconds` (null: 0) for `durationSeconds` (null: 20) on `device` tandy or pc-speaker (null: tandy) with the game scheduler and an approximate synthesizer. The player can hear it; the model cannot. Read-only and separate from live playback.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer", minimum: 0, maximum: 255 },
        startSeconds: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 300,
        },
        durationSeconds: {
          type: ["number", "null"],
          exclusiveMinimum: 0,
          maximum: 30,
        },
        device: {
          type: ["string", "null"],
          enum: ["tandy", "pc-speaker", null],
        },
      },
      required: ["num", "startSeconds", "durationSeconds", "device"],
    },
  },
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function numberInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number in ${min}..${max}.`);
  }
  return value;
}

function channelName(value: unknown): ChannelName {
  if (typeof value !== "string" || !CHANNELS.includes(value as ChannelName)) {
    throw new Error(`Channel must be one of ${CHANNELS.join(", ")}.`);
  }
  return value as ChannelName;
}

function normalizedNote(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 32) {
    throw new Error(`${label} must be a note name or null.`);
  }
  const note = value.trim().toLowerCase();
  if (note === "" || REST_NAMES.has(note)) return null;
  return note;
}

function musicNote(
  role: ChannelName,
  rawNote: unknown,
  duration: number,
  attenuation: number,
  label: string,
): SoundNoteInput {
  const note = normalizedNote(rawNote, label);
  if (note === null) return { note: null, duration, freqDivisor: null, attenuation: 15 };
  if (role === "noise") {
    const selector = NOISE_SELECTORS[note];
    if (selector === undefined) {
      throw new Error(`${label} must be periodic-low/medium/high, white-low/medium/high, or rest.`);
    }
    return { note: null, duration, freqDivisor: selector, attenuation };
  }
  const midi = parseNoteToMidi(note);
  const divisor = midiToAgiDivisor(midi);
  if (midi === null || divisor === 0) throw new Error(`${label} '${String(rawNote)}' is invalid.`);
  return { note, duration, freqDivisor: divisor, attenuation };
}

function compileMusic(args: Record<string, unknown>): {
  num: number;
  tempo: number;
  tracks: SoundTrackInput[];
  noteCount: number;
} {
  const num = integer(args["num"], "Sound number", 0, 255);
  const tempo = numberInRange(args["tempo"], "Tempo", 40, 240);
  const rawTracks = args["tracks"];
  if (!Array.isArray(rawTracks) || rawTracks.length < 1 || rawTracks.length > 4) {
    throw new Error("Tracks must contain 1..4 entries.");
  }
  const tracks: SoundTrackInput[] = CHANNELS.map(() => ({ notes: [] }));
  const seen = new Set<ChannelName>();
  let noteCount = 0;
  for (let trackIndex = 0; trackIndex < rawTracks.length; trackIndex++) {
    const rawTrack = record(rawTracks[trackIndex], `Track ${trackIndex}`);
    const role = channelName(rawTrack["channel"]);
    if (seen.has(role)) throw new Error(`Channel role '${role}' is duplicated.`);
    seen.add(role);
    const volume = integer(rawTrack["volume"], `Track ${trackIndex} volume`, 0, 15);
    const attenuation = 15 - volume;
    const events = rawTrack["events"];
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EXPANDED_NOTES) {
      throw new Error(`Track ${trackIndex} events must contain 1..${MAX_EXPANDED_NOTES} entries.`);
    }
    const notes: SoundNoteInput[] = [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const event = record(events[eventIndex], `Track ${trackIndex} event ${eventIndex}`);
      const beats = numberInRange(
        event["beats"],
        `Track ${trackIndex} event ${eventIndex} beats`,
        0,
        16,
      );
      if (beats === 0)
        throw new Error(`Track ${trackIndex} event ${eventIndex} beats must be positive.`);
      const repeat = integer(
        event["repeat"],
        `Track ${trackIndex} event ${eventIndex} repeat`,
        1,
        32,
      );
      if (noteCount + repeat > MAX_EXPANDED_NOTES) {
        throw new Error(
          `Music expands past this helper’s ${MAX_EXPANDED_NOTES}-event limit. Use write_sound for a longer score within the AGI resource size.`,
        );
      }
      const duration = Math.round((3600 * beats) / tempo);
      if (duration < 1 || duration > 65534) {
        throw new Error(
          `Track ${trackIndex} event ${eventIndex} rounds to invalid duration ${duration}; use 1..65534 ticks.`,
        );
      }
      const note = musicNote(
        role,
        event["note"],
        duration,
        attenuation,
        `Track ${trackIndex} event ${eventIndex} note`,
      );
      for (let repetition = 0; repetition < repeat; repetition++) notes.push({ ...note });
      noteCount += repeat;
    }
    tracks[CHANNEL_INDEX[role]] = { notes };
  }
  return { num, tempo, tracks, noteCount };
}

function nullableInteger(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) return fallback;
  return integer(value, label, min, max);
}

/** Execute one sound helper, or return undefined when another registry owns the name. */
export function executeSoundTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name === "preview_sound") {
    try {
      const num = integer(args["num"], "Sound number", 0, 255);
      const payload = state.container.getResource("sound", num);
      if (!payload)
        return { success: false, error: `Sound ${num} is not present in the container.` };
      const startSeconds = numberInRange(args["startSeconds"] ?? 0, "Start seconds", 0, 300);
      const durationSeconds = numberInRange(
        args["durationSeconds"] ?? 20,
        "Duration seconds",
        0,
        30,
      );
      if (durationSeconds === 0) throw new Error("Duration seconds must be positive.");
      const device = args["device"] ?? "tandy";
      if (device !== "tandy" && device !== "pc-speaker")
        throw new Error("Unknown sound preview device.");
      const { wav, ...preview } = renderSoundPreview(payload, state.profile, {
        startSeconds,
        durationSeconds,
        device,
      });
      if (wav.length <= 44)
        return {
          success: false,
          error:
            "This time window contains no sound samples. Choose a start before the sound ends and a longer duration.",
        };
      const caption = `Sound ${num} · ${device === "tandy" ? "Tandy" : "PC Speaker"} · ${preview.startSeconds.toFixed(2)}–${(preview.startSeconds + preview.durationSeconds).toFixed(2)} s · Approximate synthesis.`;
      return {
        success: true,
        message: `Sound ${num} listening preview is ready for the player. Audio is not sent to the model; use read_sound to inspect the data and timeline.`,
        details: {
          resource: { kind: "sound", num },
          revision: resourceRevision(payload),
          device,
          profile: state.profile.id,
          ...preview,
        },
        audio: [{ wav, caption, mimeType: "audio/wav" }],
      };
    } catch (error) {
      return { success: false, error: `Cannot preview sound: ${String(error)}` };
    }
  }
  if (name === "write_music") {
    try {
      const compiled = compileMusic(args);
      const payload = buildSound(compiled.tracks);
      const sound = parseSound(payload);
      state.container.putResource("sound", compiled.num, payload);
      state.sources.sounds.set(compiled.num, compiled.tracks);
      const revision = resourceRevision(payload);
      state.authoring.music ??= {};
      state.authoring.music[String(compiled.num)] = { revision, tempo: compiled.tempo };
      return {
        success: true,
        message: `Sound ${compiled.num} compiled at ${compiled.tempo} BPM (${compiled.noteCount} events, ${sound.duration} ticks, ${sound.durationSeconds.toFixed(2)} seconds), revision ${revision}.`,
        details: {
          resource: { kind: "sound", num: compiled.num },
          writtenResources: [{ kind: "sound", num: compiled.num }],
          authoringChanged: true,
          revision,
          tempo: compiled.tempo,
          notes: compiled.noteCount,
          bytes: payload.length,
          durationTicks: sound.duration,
          durationSeconds: sound.durationSeconds,
          channels: sound.channels.map((channel) => ({
            channel: channel.channelIndex,
            role: CHANNELS[channel.channelIndex],
            notes: channel.notes.length,
            durationTicks: channel.totalDuration,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: `Music was not written: ${String(error)}` };
    }
  }

  if (name === "read_sound") {
    try {
      const num = integer(args["num"], "Sound number", 0, 255);
      const requestedChannel = args["channel"];
      const channel = requestedChannel === null ? null : integer(requestedChannel, "Channel", 0, 3);
      const offset = nullableInteger(args["offset"], "Offset", 0, 0, 65535);
      const limit = nullableInteger(args["limit"], "Limit", 16, 1, 64);
      const payload = state.container.getResource("sound", num);
      if (!payload)
        return { success: false, error: `Sound ${num} is not present in the container.` };
      const sound = parseSound(payload);
      const revision = resourceRevision(payload);
      const intent = state.authoring.music?.[String(num)];
      const tempo = intent?.revision === revision ? intent.tempo : undefined;
      const requested = args["representation"] ?? "auto";
      if (requested !== "auto" && requested !== "music" && requested !== "sound")
        throw new Error("Representation must be auto, music or sound.");
      const representation =
        requested === "auto" ? (tempo === undefined ? "sound" : "music") : requested;
      const feedbackOptions: SoundFeedbackOptions = {
        num,
        channel,
        offset,
        limit,
        representation,
        ...(tempo !== undefined && representation === "music" ? { tempo } : {}),
      };
      let feedback = soundFeedback(payload, feedbackOptions);
      // Rich events have variable text cost. Keep the original precision and
      // return a shorter page when necessary; regenerate its matching image.
      if (JSON.stringify(feedback.events).length > 9000) {
        let count = feedback.events.length;
        while (count > 1 && JSON.stringify(feedback.events.slice(0, count)).length > 9000) count--;
        feedback = soundFeedback(payload, { ...feedbackOptions, limit: count });
      }
      const { events, channels, totalNotes, preview, image } = feedback;
      return {
        success: true,
        message: `Sound ${num}: ${sound.duration} ticks (${sound.durationSeconds.toFixed(2)} seconds), ${totalNotes} selected events. Returned ${events.length} event(s) from offset ${offset}; ${representation === "music" ? "musical score with estimated pitches" : "frequency and noise timeline"}; revision ${revision}.`,
        details: {
          resource: { kind: "sound", num },
          revision,
          bytes: payload.length,
          durationTicks: sound.duration,
          durationSeconds: sound.durationSeconds,
          representation,
          representationSource:
            requested === "auto"
              ? tempo === undefined
                ? "unclassified"
                : "authored-music"
              : "explicit",
          tempo: representation === "music" ? (tempo ?? null) : null,
          meter: null,
          timing:
            "Durations and onsets are compiled 60 Hz ticks. No meter or original imported tempo is inferred. Volume is the base level before profile envelopes and live sound settings.",
          channels,
          totalNotes,
          offset,
          limit,
          returned: events.length,
          hasMore: offset + events.length < totalNotes,
          nextOffset: offset + events.length < totalNotes ? offset + events.length : null,
          events,
          preview,
        },
        images: [image],
      };
    } catch (error) {
      return { success: false, error: `Cannot read sound: ${String(error)}` };
    }
  }

  return undefined;
}
