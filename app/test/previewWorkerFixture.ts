import assert from "node:assert/strict";
import {
  inspectGame,
  type PreviewWorkerInbound,
  type PreviewWorkerOutbound,
} from "../src/library/gameInspection.ts";

/** Only the worker transport and PNG encoding are fake; inspection runs the real Engine. */
export function installPreviewWorkerFixture(t: { after(callback: () => void): void }): void {
  const replacements = {
    Worker: class {
      onmessage?: (event: { data: PreviewWorkerOutbound }) => void;
      terminate() {}
      postMessage(data: PreviewWorkerInbound) {
        assert.ok(
          Object.keys(data).every((key) =>
            ["files", "words", "profile", "legacyRoomMemory"].includes(key),
          ),
          "private project data must stay outside the preview worker",
        );
        void inspectGame(structuredClone(data)).then(
          (result) => this.onmessage?.({ data: { result } }),
          (error: unknown) =>
            this.onmessage?.({
              data: { error: error instanceof Error ? error.message : String(error) },
            }),
        );
      }
    },
    document: {
      createElement: () => ({
        getContext: () => ({ putImageData() {} }),
        toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
      }),
    },
    ImageData: class {},
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}
