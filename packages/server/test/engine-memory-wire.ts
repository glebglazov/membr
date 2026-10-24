import { mock } from "bun:test";
import { z } from "zod";

type Input = { id: number; n?: number; at?: number };
type WireTool = { name: string; description: string; inputSchema: Record<string, z.ZodType>; handler: (args: Input) => Promise<unknown> };
type WireMessage = { uuid: string };
type Options = { mcpServers?: Record<string, { tools: WireTool[] }>; allowedTools?: string[]; canUseTool: (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown> };
let registered: unknown;
let answers: unknown;
let allowed: unknown;
let permissions: unknown;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool(name: string, description: string, inputSchema: WireTool["inputSchema"], handler: WireTool["handler"]) { return { name, description, inputSchema, handler }; },
  createSdkMcpServer(options: { name: string; tools: WireTool[] }) { return options; },
  query({ prompt, options }: { prompt: AsyncIterable<WireMessage>; options: Options }) {
    const tools = options.mcpServers?.memory.tools;
    if (!tools) throw new Error("The Engine did not register the memory server");
    registered = tools.map((tool) => ({ name: tool.name, description: tool.description }));
    allowed = options.allowedTools;
    return {
      async *[Symbol.asyncIterator]() {
        const zoom = tools.find((tool) => tool.name === "zoom");
        const date = tools.find((tool) => tool.name === "date");
        if (!zoom || !date) throw new Error("A memory tool is missing");
        permissions = await Promise.all(["mcp__memory__zoom", "mcp__memory__date"].map((name) => options.canUseTool(name, { id: 3 }, { signal: new AbortController().signal })));
        answers = [await zoom.handler({ id: 3, n: 1, at: 0 }), await zoom.handler({ id: 99 }), await date.handler({ id: 3 })];
        for await (const message of prompt) yield { type: "result", subtype: "success", is_error: false, result: "ok", user_message_uuid: message.uuid, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } };
      },
      close() {},
    };
  },
}));
const { claude } = await import("../src/engine.ts");
const epoch = claude.open("a view", {
  cwd: process.cwd(), append: "", pick: { model: "sonnet", effort: "low", fast: false },
  memory: {
    zoom(id, n, at) { return id === 3 ? { text: `${id},${n},${at}`, error: false, images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] } : { text: "No line 99+1. Roots: 0+4.", error: true, images: [] }; },
    date(id) { return "date " + id; },
  },
});
epoch.send("get the memory", "next", "user");
for await (const event of epoch.events) if (event.kind === "end") break;
epoch.close();
console.log(JSON.stringify({ registered, answers, allowed, permissions }));
