import type { Engine } from "./engine.ts";
import type { Epochs } from "./epochs.ts";

const DAY = 86_400_000;

export async function cleanupEpochs(epochs: Epochs, engine: Engine, activeEpoch: string, now = Date.now(), cwd?: string): Promise<void> {
  const cutoff = now - 30 * DAY;
  const expired = Object.entries(epochs.list).filter(([epoch, record]) => epoch !== activeEpoch && Date.parse(record.date) < cutoff);
  for (const [, record] of expired) await engine.deleteSession(record.session, cwd);
  if (expired.length) epochs.remove(expired.map(([epoch]) => epoch));
}
