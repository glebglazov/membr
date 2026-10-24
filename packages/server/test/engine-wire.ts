import { mock } from "bun:test";

type WireMessage = { type: string; uuid: string; isSynthetic?: boolean; message: { content: string } };
type QueryInput = { prompt: AsyncIterable<WireMessage>; options: { permissionMode?: string; canUseTool?: (tool: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown> } };
const calls: Array<{ permissionMode?: string; messages: WireMessage[] }> = [];
const controller = new AbortController();
let permission: unknown;
let signalPassed = false;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer() { throw new Error("No MCP server was scripted"); },
  tool() { throw new Error("No MCP tool was scripted"); },
  query({ prompt, options }: QueryInput) {
    const call: { permissionMode?: string; messages: WireMessage[] } = { permissionMode: options.permissionMode, messages: [] };
    calls.push(call);
    return {
      async *[Symbol.asyncIterator]() {
        if (options.canUseTool) permission = await options.canUseTool("Bash", { command: "echo hello" }, { signal: controller.signal });
        for await (const message of prompt) {
          call.messages.push(message);
          yield { type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", user_message_uuid: message.uuid, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } };
        }
      },
      close() {},
    };
  },
}));

const { claude } = await import("../src/engine.ts");
const epoch = claude.open("chat view", {
  cwd: process.cwd(), append: "", pick: { model: "sonnet", effort: "low", fast: false },
  ask: async (_tool, _input, signal) => { signalPassed = signal === controller.signal; return true; },
});
epoch.send("[Agent] report", "next", "membr");
epoch.send("goal check", "next", "membr");
epoch.send("The user typed this", "next", "user");
let ends = 0;
for await (const event of epoch.events) {
  if (event.kind === "end" && ++ends === 3) break;
}
epoch.close();
await claude.compact("compaction input");
console.log(JSON.stringify({ calls, permission, signalPassed }));
