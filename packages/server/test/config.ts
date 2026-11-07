import path from "node:path";
import { APPROVAL_TIMEOUT, DEFAULT_AGENT, storeDir, type AgentConfig, type Config } from "../src/config.ts";

// A Config for serveHub's config option: the listed agents, each with a home under its own store unless it names one.
export function testConfig(dir: string, agents: Array<Partial<AgentConfig> & { name: string }> = [{ name: DEFAULT_AGENT }]): Config {
  return {
    listen: { port: 0, host: "127.0.0.1", tailscale: false },
    agents: new Map(agents.map((agent) => [agent.name, { name: agent.name, home: agent.home ?? path.join(storeDir(dir, agent.name), "home"), prompt: agent.prompt ?? "", common: agent.common ?? "", approvalTimeout: agent.approvalTimeout ?? APPROVAL_TIMEOUT }])),
  };
}

// The default agent's store inside a data directory, where a test that reads or seeds files looks.
export const defaultStore = (dir: string) => storeDir(dir, DEFAULT_AGENT);
