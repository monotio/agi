import packageInfo from "../../../../package.json";
import { attachLogicLanguageServer } from "./analysisService.ts";

import type { LspMessage, LspNotification, LspResponse } from "../../../../src/logic/lspTypes.ts";

const port = {
  onmessage: null as ((event: { data: LspMessage }) => void) | null,
  postMessage: (message: LspResponse | LspNotification) => self.postMessage(message),
};
attachLogicLanguageServer(port, { version: packageInfo.version });
self.onmessage = (event) => port.onmessage?.(event);
