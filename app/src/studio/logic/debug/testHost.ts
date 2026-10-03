/**
 * The isolated test run's host adapter. The worker suspends the engine on
 * host services and posts `hostRequest`; this adapter answers them for a
 * test run without touching durable storage: save images live in a memory
 * table that belongs to one build identity, prompts go to injected UI
 * callbacks, and a room request can never arrive — the frozen boot pins
 * room authoring off, so the engine reports a missing room itself. A
 * defensive `""` answer keeps that contract if a worker still asks.
 *
 * Answer encodings mirror hostRequests.deliverHostResponse exactly: the
 * wire string IS the engine's answer — getnum a decimal string, getstring
 * the raw line, saveList a JSON slot list of base64 images, saveDescription
 * JSON `{value}`, saveWrite "true"/"false", restore a base64 image or "".
 */
import { base64ToBytes, bytesToBase64 } from "../../../project/bytes.ts";

/** One save slot in the ephemeral store. The image is owned — callers get copies. */
export interface TestSaveSlot {
  readonly slot: number;
  readonly description: string;
  readonly image: Uint8Array;
}

/** `get.num`: the engine shows `prompt` on the input row at (row, col). */
interface TestNumberRequest {
  readonly op: "getnum";
  readonly prompt: string;
  readonly row: number;
  readonly col: number;
}

/** `get.string`: the engine prompts at (row, col) for at most `maxLen` characters. */
export interface TestStringRequest {
  readonly op: "getstring";
  readonly prompt: string;
  readonly maxLen: number;
  readonly row: number;
  readonly col: number;
}

/** The native save dialog's description field, seeded with `initial`. */
export interface TestDescriptionRequest {
  readonly op: "saveDescription";
  readonly initial: string;
  readonly maxLen: number;
  readonly row: number;
  readonly col: number;
}

/**
 * Prompt callbacks the Studio injects. Returning/resolving null cancels the
 * prompt, which the engine reads as an empty answer. `signal` aborts when
 * the run that asked is replaced or closed — the answer is never delivered.
 */
export interface TestPrompts {
  getNumber?(req: TestNumberRequest, signal: AbortSignal): number | null | Promise<number | null>;
  getString?(req: TestStringRequest, signal: AbortSignal): string | null | Promise<string | null>;
  saveDescription?(
    req: TestDescriptionRequest,
    signal: AbortSignal,
  ): string | null | Promise<string | null>;
}

/** One worker `hostRequest`, normalized for the adapter. */
export interface TestHostRequest {
  readonly id: number;
  readonly op: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface TestHost {
  /**
   * Serve one host request; resolves with the wire response string for the
   * matching `hostAnswer`. `signal` aborts when the run is torn down.
   */
  handle(request: TestHostRequest, signal: AbortSignal): Promise<string>;
  /** The store's slots in slot order; detached copies. */
  slots(): readonly TestSaveSlot[];
  /** Drop every slot — a replaced build owns an empty store. */
  clear(): void;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`host request ${what} is not an integer`);
  }
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`host request ${what} is not a string`);
  return value;
}

export function createTestHost(prompts: TestPrompts = {}): TestHost {
  const slots = new Map<number, { image: Uint8Array; description: string }>();
  // The dialog asks for a description before the write arrives; the write
  // carries only slot+image, so the store keeps the last answered text.
  let described: string | null = null;
  // Ownership guards for that shared field: a clear() starts a new
  // generation, and only the newest saveDescription request may publish —
  // a cancelled, superseded or stale-generation callback cannot write a
  // description into a store it no longer belongs to.
  let generation = 0;
  let descriptionTicket = 0;

  async function handle(request: TestHostRequest, signal: AbortSignal): Promise<string> {
    const { context } = request;
    switch (request.op) {
      case "getnum": {
        const req: TestNumberRequest = {
          op: "getnum",
          prompt: str(context["prompt"], "prompt"),
          row: num(context["row"], "row"),
          col: num(context["col"], "col"),
        };
        const value = prompts.getNumber ? await prompts.getNumber(req, signal) : null;
        return value === null ? "" : String(value & 0xff);
      }
      case "getstring": {
        const req: TestStringRequest = {
          op: "getstring",
          prompt: str(context["prompt"], "prompt"),
          maxLen: num(context["maxLen"], "maxLen"),
          row: num(context["row"], "row"),
          col: num(context["col"], "col"),
        };
        const value = prompts.getString ? await prompts.getString(req, signal) : null;
        return value ?? "";
      }
      case "saveDescription": {
        const req: TestDescriptionRequest = {
          op: "saveDescription",
          initial: typeof context["initial"] === "string" ? context["initial"] : "",
          maxLen: num(context["maxLen"], "maxLen"),
          row: num(context["row"], "row"),
          col: num(context["col"], "col"),
        };
        const ticket = ++descriptionTicket;
        const gen = generation;
        const value = prompts.saveDescription ? await prompts.saveDescription(req, signal) : null;
        if (!signal.aborted && gen === generation && ticket === descriptionTicket) {
          described = value;
        }
        return JSON.stringify({ value });
      }
      case "saveList": {
        const listing = [...slots.entries()]
          .sort(([a], [b]) => a - b)
          .map(([slot, s]) => ({ slot, image: bytesToBase64(s.image) }));
        return JSON.stringify(listing);
      }
      case "saveWrite": {
        const slot = num(context["slot"], "slot");
        const image = base64ToBytes(str(context["image"], "image"));
        if (image.length === 0) return "false";
        const description = described ?? slots.get(slot)?.description ?? "";
        described = null;
        slots.set(slot, { image, description });
        return "true";
      }
      case "restore": {
        const slot = slots.get(num(context["slot"], "slot"));
        return slot ? bytesToBase64(slot.image) : "";
      }
      // Room requests cannot occur — the frozen boot pins authoring off —
      // and an empty answer is the worker's honest decline path.
      default:
        return "";
    }
  }

  return {
    handle,
    slots: () =>
      [...slots.entries()]
        .sort(([a], [b]) => a - b)
        .map(([slot, s]) => ({ slot, description: s.description, image: new Uint8Array(s.image) })),
    clear() {
      generation++;
      slots.clear();
      described = null;
    },
  };
}
