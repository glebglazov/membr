import { main } from "../src/main.ts";
import { END, FakeEngine } from "./engine.ts";

await main(new FakeEngine((epoch) => epoch.emit(END)));
