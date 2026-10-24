import { mock } from "bun:test";

type WireMessage = { uuid: string; message: { content: unknown } };
const messages: WireMessage[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer() { throw new Error("No MCP server was scripted"); },
  tool() { throw new Error("No MCP tool was scripted"); },
  query({ prompt }: { prompt: AsyncIterable<WireMessage> }) {
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          messages.push(message);
          yield { type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", user_message_uuid: message.uuid, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } };
        }
      },
      close() {},
    };
  },
}));
const { claude } = await import("../src/engine.ts");
const epoch = claude.open("view", { cwd: process.cwd(), append: "", pick: { model: "sonnet", effort: "low", fast: false } });
epoch.send("Look", "now", "user", [{ data: "cGljdHVyZQ==", mimeType: "image/jpeg" }]);
epoch.send("", "next", "user", [{ data: "aW1hZ2U=", mimeType: "image/png" }]);
let ends = 0;
for await (const event of epoch.events) if (event.kind === "end" && ++ends === 2) break;
epoch.close();
console.log(JSON.stringify(messages));
