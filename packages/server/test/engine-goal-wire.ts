import { mock } from "bun:test";

type WireMessage = { isSynthetic?: boolean; message: { content: string } };
type Options = { model?: string; systemPrompt?: string; tools?: string[]; settingSources?: string[]; persistSession?: boolean; maxTurns?: number; abortController?: AbortController };
const calls: Array<{ options: Options; messages: WireMessage[] }> = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer() { throw new Error("No MCP server was scripted"); },
  tool() { throw new Error("No MCP tool was scripted"); },
  query({ prompt, options }: { prompt: AsyncIterable<WireMessage>; options: Options }) {
    const call = { options, messages: [] as WireMessage[] };
    calls.push(call);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          call.messages.push(message);
          yield message.message.content.includes("Fail this check")
            ? { type: "result", subtype: "error_during_execution", errors: ["unavailable"] }
            : { type: "result", subtype: "success", is_error: false, result: "yes", stop_reason: "end_turn" };
        }
      },
      close() {},
    };
  },
}));

const { claude } = await import("../src/engine.ts");
const met = await claude.checkGoal("Finish the job", "<chat>\n0+1|user: Start\n</chat>\n", new AbortController().signal);
let failure = "";
try { await claude.checkGoal("Fail this check", "<chat></chat>", new AbortController().signal); }
catch (error) { failure = error instanceof Error ? error.message : String(error); }
console.log(JSON.stringify({ met, failure, calls: calls.map(({ options, messages }) => ({
  model: options.model, systemPrompt: options.systemPrompt, tools: options.tools,
  settingSources: options.settingSources, persistSession: options.persistSession,
  maxTurns: options.maxTurns, abortController: options.abortController instanceof AbortController,
  messages,
})) }));
