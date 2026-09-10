import type { LogAgentFn } from "./useInputController.ts";
import { readGameSaves, writeGameSave } from "./gameSaves.ts";
import type { BootedGame } from "./gameTypes.ts";

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
 * Handles host bridge save slot operations (`restore`, `saveList`, `saveWrite`),
 * reading and writing 12-slot saves from local storage scoped by game key.
 */
export function useSaveSlotController(options: SaveSlotControllerOptions): SaveSlotController {
  const getStorage = (): Pick<Storage, "getItem" | "setItem"> => {
    if (options.storage) return options.storage;
    if (typeof localStorage !== "undefined") return localStorage;
    throw new Error("Local storage is not available.");
  };

  function activeSaveKey(): string | null {
    const booted = options.getBootedGame();
    if (!booted) return null;
    return booted.installed ? (booted.hash ?? null) : (booted.projectId ?? null);
  }

  function readActiveSlots(): Record<string, string> {
    const key = activeSaveKey();
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
      try {
        const slot = Number(context["slot"]);
        saved = Number.isInteger(slot) ? readActiveSlots()[String(slot)] : null;
      } catch {
        saved = null;
      }
      if (!saved) {
        options.logAgent?.("log", "No saved game found in local storage.");
        return Promise.resolve("");
      }
      options.logAgent?.("log", "Restoring saved game from local storage...");
      return Promise.resolve(saved);
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
      const key = activeSaveKey();
      try {
        return String(
          Boolean(
            key &&
            writeGameSave(getStorage(), key, Number(context["slot"]), String(context["image"])),
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
