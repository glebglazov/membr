import { main } from "../src/main.ts";
import { END, FakeEngine } from "./engine.ts";

await main(new FakeEngine((epoch, message) => {
  if (message.text.trim() === "hold") return;
  const command = message.text.trim() === "approve repeat" ? "pwd" : message.text.trim();
  const interrupts = epoch.interrupts;
  void epoch.options.ask?.("Bash", { command }).then((allowed) => {
    if (epoch.closed || epoch.interrupts !== interrupts) return;
    epoch.emit(
      { kind: "text", text: allowed ? `Approved ${command}. The turn continued.` : `Denied ${command}. The turn continued.` },
      { ...END, usage: message.text.trim() === "uncached" ? { input: 800, cacheRead: 100, cacheWrite: 100, output: 50 } : { input: 100, cacheRead: 700, cacheWrite: 200, output: 50 } },
    );
  });
}));
