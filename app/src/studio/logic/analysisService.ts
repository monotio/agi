import {
  createLogicLspServer,
  type LogicLanguageSettings,
} from "../../../../src/logic/lspServer.ts";
import type { LspMessage, LspNotification, LspResponse } from "../../../../src/logic/lspTypes.ts";

interface LanguagePort {
  onmessage: ((event: { data: LspMessage }) => void) | null;
  postMessage(message: LspResponse | LspNotification): void;
}

/** The worker and fake test ports carry ordinary LSP JSON-RPC messages. */
export function attachLogicLanguageServer(
  port: LanguagePort,
  options: { version?: string; schedule?: (run: () => void) => void } = {},
) {
  const core = createLogicLspServer({
    ...options,
  });
  const schedule =
    options.schedule ??
    ((run: () => void) => {
      setTimeout(run, 0);
    });
  let generation = 0;
  const queued = new Set<string | number>();
  port.onmessage = ({ data }) => {
    if (data.id === undefined) {
      const settings = (
        data.params as { settings?: { agiLogic?: LogicLanguageSettings } } | undefined
      )?.settings?.agiLogic;
      if (
        (data.method === "workspace/didChangeConfiguration" && settings?.project) ||
        ["textDocument/didChange", "textDocument/didClose"].includes(data.method)
      )
        generation++;
      if (data.method === "$/cancelRequest") {
        const id = (data.params as { id?: string | number } | undefined)?.id;
        if (id === undefined || !queued.has(id)) return;
      }
      core.handle(data);
      return;
    }
    const id = data.id;
    const captured = data.method === "initialize" ? undefined : generation;
    queued.add(id);
    // Yield before each request so newer documents and cancellation messages
    // invalidate queued work before it enters the synchronous language core.
    schedule(() => {
      queued.delete(id);
      if (captured !== undefined && captured !== generation)
        core.handle({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
      const response = core.handle(data);
      if (response) port.postMessage(response);
    });
  };
}
