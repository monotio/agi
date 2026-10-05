import type { LogAgentFn } from "../play/useInputController.ts";
import { readGameSaves, readGameSaveRecord, writeGameSave } from "./gameSaves.ts";
import { resolveProgressTarget } from "../project/progressBinding.ts";
import type { BootedGame } from "../project/gameTypes.ts";

export interface SaveSlotControllerOptions {
  readonly getBootedGame: () => BootedGame | null;
  readonly logAgent?: LogAgentFn;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface SaveSlotController {
  readonly handleSaveSlotRequest: (
    op: "restore" | "saveList" | "saveWrite",
    context: Record<string, unknown>,
  ) => Promise<string> | string;
}

/**
 * Handles host save slot operations (`restore`, `saveList`, `saveWrite`),
 * reading and writing 12-slot saves from local storage scoped by game key.
 */
export function useSaveSlotController(options: SaveSlotControllerOptions): SaveSlotController {
  const getStorage = (): Pick<Storage, "getItem" | "setItem"> => {
    if (options.storage) return options.storage;
    if (typeof localStorage !== "undefined") return localStorage;
    throw new Error("Local storage is not available.");
  };

  function activeSaveTarget() {
    const booted = options.getBootedGame();
    if (!booted) return null;
    // Save slots use the bound instance: the exact installed folder or
    // the saved project and its captured body epoch.
    return resolveProgressTarget(booted);
  }

  function readActiveSlots(): Record<string, string> {
    const key = activeSaveTarget();
    if (!key) return {};
    return readGameSaves(getStorage(), key);
  }

  function handleSaveSlotRequest(
    op: "restore" | "saveList" | "saveWrite",
    context: Record<string, unknown>,
  ): Promise<string> | string {
    if (op === "restore") {
      // The stored value is the base64 save-file image itself; an empty
      // reply is the engine's "cancelled / no save" answer.
      let saved: string | undefined | null;
      let region: "ntsc" | "pal" | undefined;
      try {
        const slot = Number(context["slot"]);
        const target = activeSaveTarget();
        const record = target ? readGameSaveRecord(getStorage(), target) : null;
        saved = Number.isInteger(slot) ? record?.slots[String(slot)] : null;
        region = record?.amigaRegions[String(slot)];
      } catch {
        saved = null;
      }
      if (!saved) {
        options.logAgent?.("log", "No saved game found in local storage.");
        return Promise.resolve("");
      }
      options.logAgent?.("log", "Restoring saved game from local storage...");
      return Promise.resolve(
        region === "pal" ? JSON.stringify({ image: saved, amigaRegion: region }) : saved,
      );
    }
    if (op === "saveList") {
      if (!options.getBootedGame()) return "[]";
      try {
        const slots = readActiveSlots();
        // Only the description/signature header is needed for the selector.
        // Full images are fetched on restore, keeping the SAB reply bounded.
        return JSON.stringify(
          Object.entries(slots).flatMap(([slot, image]) => {
            try {
              return [{ slot: Number(slot), image: btoa(atob(image).slice(0, 40)) }];
            } catch {
              return [];
            }
          }),
        );
      } catch {
        return "storage-error";
      }
    }
    if (op === "saveWrite") {
      // A removed project stores nothing: its saves would outlive it and
      // resurface when the game is added again.
      if (options.getBootedGame()?.removed) return "false";
      const key = activeSaveTarget();
      try {
        return String(
          Boolean(
            key &&
            writeGameSave(
              getStorage(),
              key,
              Number(context["slot"]),
              String(context["image"]),
              context["amigaRegion"] === "pal" ? "pal" : "ntsc",
            ),
          ),
        );
      } catch {
        return "false";
      }
    }
    return "";
  }

  return { handleSaveSlotRequest };
}
