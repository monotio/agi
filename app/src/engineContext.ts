/**
 * The engine API is provided once by App.vue and injected by the components
 * that need it, so it never travels through props. Local view data still
 * moves through props and emits.
 */
import { inject, provide, type InjectionKey } from "vue";
import type { useEngine } from "./useEngine.ts";

export type EngineApi = ReturnType<typeof useEngine>;

export const engineKey: InjectionKey<EngineApi> = Symbol("agi-engine");

export function provideEngine(engine: EngineApi): void {
  provide(engineKey, engine);
}

export function useEngineApi(): EngineApi {
  const engine = inject(engineKey);
  if (!engine) throw new Error("useEngineApi: App.vue did not provide the engine");
  return engine;
}
