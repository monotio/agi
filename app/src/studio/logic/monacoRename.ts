import { RenameWidget } from "monaco-editor/editor/contrib/rename/browser/renameWidget.js";
import { patchRenameFocus } from "./renameFocus.ts";

patchRenameFocus(RenameWidget.prototype);
