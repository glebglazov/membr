// wake returns the cancel. Tests pass a fake, so time moves without waiting.
export type Clock = { now(): number; wake(ms: number, run: () => void): () => void };

export const systemClock: Clock = {
  now: () => Date.now(),
  wake(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
