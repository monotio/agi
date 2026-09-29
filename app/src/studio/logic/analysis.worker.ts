import { createLogicAnalysisService } from "./analysisService.ts";
import type { LogicAnalysisRequest } from "./analysisProtocol.ts";

const analyze = createLogicAnalysisService();
self.onmessage = (event: MessageEvent<LogicAnalysisRequest>) =>
  self.postMessage(analyze(event.data));
