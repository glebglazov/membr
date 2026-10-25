import { mock } from "bun:test";
import { z } from "zod";

type WireTool = { name: string; description: string; handler: (input: unknown) => Promise<unknown> };
type Message = { uuid: string; isSynthetic: boolean; message: { content: string } };
type Call = { tools: Array<{ name: string; description: string }>; allowed?: string[]; messages: Message[] };
const calls: Call[] = [];
const answers: unknown[] = [];
const delegated: unknown[] = [];
const permissions: unknown[] = [];
const requests: string[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool<T extends z.ZodRawShape>(name: string, description: string, schema: T, handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>) { return { name, description, handler: (input: unknown) => handler(z.object(schema).parse(input)) }; },
  createSdkMcpServer(options: { tools: WireTool[] }) { return options; },
  query({ prompt, options }: { prompt: AsyncIterable<Message>; options: { mcpServers: { memory: { tools: WireTool[] } }; allowedTools?: string[]; canUseTool: (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown> } }) {
    const tools = options.mcpServers.memory.tools;
    const call: Call = { tools: tools.map(({ name, description }) => ({ name, description })), allowed: options.allowedTools, messages: [] };
    calls.push(call);
    return {
      async *[Symbol.asyncIterator]() {
        const spawn = tools.find((tool) => tool.name === "spawn");
        const tell = tools.find((tool) => tool.name === "tell");
        if (spawn && tell) {
          for (const name of ["mcp__memory__spawn", "mcp__memory__tell"]) permissions.push(await options.canUseTool(name, {}, { signal: new AbortController().signal }));
        }
        if (spawn && tell) answers.push(await spawn.handler({ tasks: [{ name: "reader", task: "Task" }], effort: "high" }), await tell.handler({ name: "reader", message: "More" }));
        for await (const message of prompt) {
          call.messages.push(message);
          yield { type: "result", subtype: "success", is_error: false, result: "done", user_message_uuid: message.uuid, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } };
        }
      },
      close() {},
    };
  },
}));
const { claude } = await import("../src/engine.ts");
const options = { cwd: process.cwd(), append: "rules", pick: { model: "sonnet", effort: "low" as const, fast: false }, memory: { zoom: () => ({ text: "chat", error: false, images: [] }), date: () => "date" } };
const main = claude.open("view", { ...options, ask: async (tool) => { requests.push(tool); return tool === "mcp__memory__tell"; }, agents: { spawn(tasks, effort) { delegated.push({ tasks, effort }); return "Started reader."; }, tell(name, message) { delegated.push({ name, message }); return "Sent."; } } });
main.send("Work", "now", "user");
for await (const event of main.events) if (event.kind === "end") break;
main.close();
const child = claude.open("view and saved agent chat", options);
child.send("Agent task", "now", "membr");
child.send("Agent correction", "next", "membr");
for await (const event of child.events) if (event.kind === "end" && event.through === 2) break;
child.close();
console.log(JSON.stringify({ calls, answers, delegated, permissions, requests }));
