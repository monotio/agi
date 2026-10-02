import { createLogicLspServer } from "../../../../src/logic/lspServer.ts";
import type { LspMessage, LspNotification, LspResponse } from "../../../../src/logic/lspTypes.ts";

interface LanguagePort {
  onmessage: ((event: { data: LspMessage }) => void) | null;
  postMessage(message: LspResponse | LspNotification): void;
}

/** The worker and fake test ports carry ordinary LSP JSON-RPC messages. */
export function attachLogicLanguageServer(port: LanguagePort, options: { version?: string } = {}) {
  const core = createLogicLspServer({
    ...options,
    publish: (message) => port.postMessage(message),
  });
  port.onmessage = ({ data }) => {
    const response = core.handle(data);
    if (response) port.postMessage(response);
  };
}
