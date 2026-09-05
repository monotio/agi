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

const NOISE_NAMES: Record<string, string> = {
  "0": "periodic-high",
  "1": "periodic-medium",
  "2": "periodic-low",
  "4": "white-high",
  "5": "white-medium",
  "6": "white-low",
};

const REST_NAMES = new Set(["rest", "r", "silence"]);
const MAX_EXPANDED_NOTES = 4096;

/** Strict-compatible schemas for compact music writing and bounded sound reading. */
export const SOUND_TOOLS: readonly ToolDefinition[] = [
  {
    name: "write_music",
    description:
      "Compile compact beat-based music into an authentic four-channel AGI sound. Named roles map to melody=0, harmony=1, bass=2, noise=3 regardless of track order. Tone notes use names such as C4, F#4, or Bb3; null or 'rest' is silence. Noise notes are periodic-low/medium/high or white-low/medium/high. Volume is human-facing: 15 is loudest and 0 is quietest. Repeats expand deterministically, with at most 4096 compiled events.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Sound resource number.",
        },
        tempo: {
          type: "number",
          minimum: 40,
          maximum: 240,
          description: "Tempo in beats per minute.",
        },
        tracks: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "One track per unique named channel role.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: {
                type: "string",
                enum: CHANNELS,
                description: "Unique channel role.",
              },
              volume: {
                type: "integer",
                minimum: 0,
                maximum: 15,
                description: "Human loudness: 15 loudest, 0 quietest.",
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
                      description: "Tone note name, noise mode name, or null/'rest' for silence.",
                    },
                    beats: {
                      type: "number",
                      exclusiveMinimum: 0,
                      maximum: 16,
                      description: "Duration in beats before repeat expansion.",
                    },
                    repeat: {
                      type: "integer",
                      minimum: 1,
                      maximum: 32,
                      description: "Number of times to emit this event.",
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
      "Inspect an authentic compiled sound with bounded paging. Returns factual channel note counts and durations plus control byte, duration, and attenuation for at most 64 events. Tone channels include the original tone word and frequency divisor; noise events instead return null for those fields plus their authentic selector and named noise mode. Set channel null to page across all four channels; offset and limit null use 0 and 16.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Sound resource number.",
        },
        channel: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 3,
          description: "Channel 0..3, or null for all channels.",
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 65535,
          description: "Event offset in the selected channel set; null means 0.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 64,
          description: "Maximum returned events; null means 16.",
        },
      },
      required: ["num", "channel", "offset", "limit"],
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
  if (name === "write_music") {
    try {
      const compiled = compileMusic(args);
      const payload = buildSound(compiled.tracks);
      const sound = parseSound(payload);
      state.container.putResource("sound", compiled.num, payload);
      state.sources.sounds.set(compiled.num, compiled.tracks);
      const revision = resourceRevision(payload);
      return {
        success: true,
        message: `Sound ${compiled.num} compiled at ${compiled.tempo} BPM (${compiled.noteCount} events, ${sound.duration} ticks, ${sound.durationSeconds.toFixed(2)} seconds), revision ${revision}.`,
        details: {
          resource: { kind: "sound", num: compiled.num },
          writtenResources: [{ kind: "sound", num: compiled.num }],
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
      const selected = channel === null ? sound.channels : [sound.channels[channel]!];
      const allEvents = selected.flatMap((item) =>
        item.notes.map((note, index) => {
          const noiseSelector = item.channelIndex === 3 ? (note.tone >> 8) & 0x07 : null;
          return {
            channel: item.channelIndex,
            index,
            tone: item.channelIndex === 3 ? null : note.tone,
            control: note.control,
            freqDivisor: item.channelIndex === 3 ? null : note.freqDivisor,
            ...(noiseSelector === null
              ? {}
              : {
                  noiseSelector,
                  noise: NOISE_NAMES[String(noiseSelector)] ?? `unknown-${noiseSelector}`,
                }),
            duration: note.duration,
            attenuation: note.attenuation,
          };
        }),
      );
      const events = allEvents.slice(offset, offset + limit);
      const revision = resourceRevision(payload);
      return {
        success: true,
        message: `Sound ${num}: ${sound.duration} ticks (${sound.durationSeconds.toFixed(2)} seconds), ${allEvents.length} selected events. Returned ${events.length} event(s) from offset ${offset}; revision ${revision}.`,
        details: {
          resource: { kind: "sound", num },
          revision,
          bytes: payload.length,
          durationTicks: sound.duration,
          durationSeconds: sound.durationSeconds,
          channels: selected.map((item) => ({
            channel: item.channelIndex,
            role: CHANNELS[item.channelIndex],
            notes: item.notes.length,
            durationTicks: item.totalDuration,
          })),
          totalNotes: allEvents.length,
          offset,
          limit,
          returned: events.length,
          hasMore: offset + events.length < allEvents.length,
          events,
        },
      };
    } catch (error) {
      return { success: false, error: `Cannot read sound: ${String(error)}` };
    }
  }

  return undefined;
}
