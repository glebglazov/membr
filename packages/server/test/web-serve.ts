import { main } from "../src/main.ts";
import { END, FakeEngine } from "./engine.ts";

await main(new FakeEngine((epoch, message) => {
  const interrupts = epoch.interrupts;
  epoch.emit({ kind: "delta", text: "I will check " });
  if (message.text.trim() === "hold") return;
  setTimeout(() => {
    if (epoch.closed || epoch.interrupts !== interrupts) return;
    epoch.emit({ kind: "delta", text: "the folder." });
    setTimeout(() => {
      if (epoch.closed || epoch.interrupts !== interrupts) return;
      epoch.emit(
        { kind: "text", text: "I will check the folder." },
        { kind: "tool", id: "call-1", name: "Bash", input: { command: "pwd" } },
        { kind: "echo", id: "call-1", text: "/project", error: false },
        { kind: "text", text: "The folder is /project." },
        END,
      );
    }, 1000);
  }, 1000);
}));
