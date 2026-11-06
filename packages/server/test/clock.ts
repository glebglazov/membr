import type { Clock } from "../src/clock.ts";

// Time moves only on advance, which runs each wake that falls due, in order, at its own time.
export class FakeClock implements Clock {
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private next = 0;
  constructor(public time = 0) {}
  now() { return this.time; }
  wake(ms: number, run: () => void) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return () => { this.timers.delete(id); };
  }
  advance(ms: number) { this.until(this.time + ms); }
  until(end: number) {
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].run();
    }
    this.time = end;
  }
}
