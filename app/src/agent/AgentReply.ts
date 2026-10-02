import { defineComponent, h, type VNodeChild } from "vue";
import { parseAgentMarkdown, type MarkdownNode } from "./agentMarkdown.ts";

function renderNode(node: MarkdownNode): VNodeChild {
  if (typeof node === "string") return node;
  return h(node.tag, node.children.map(renderNode));
}
export default defineComponent({
  name: "AgentMarkdown",
  props: { text: { type: String, required: true } },
  setup(props) {
    return () =>
      h("div", { class: "agent-panel__markdown" }, parseAgentMarkdown(props.text).map(renderNode));
  },
});
