import { NOTEBOOK_CAP, type Answer, type Entry, type Event, type NotebookAct } from "@membr/protocol";
import type { Log } from "./log.ts";

export type Edit = { old: string; new: string };
// The reason is written for the model. show: the refusal means the model has a stale picture, so it gets the current notebook with it.
export type Revised = { ok: true; text: string } | { ok: false; reason: string; show: boolean };
export type NotebookTools = { edit(edits: Edit[]): { text: string; error: boolean } };
type NotebookEvent = Extract<Event, { type: "notebook" }>;

// A user edit that the epoch has not seen is sent as its diff; past this size the whole notebook is cheaper to read.
const NOTICE_LIMIT = 2048;
// Past this many line pairs the diff stops looking for common lines and shows the whole middle as replaced.
const DIFF_WORK = 1_000_000;

const size = (text: string) => Buffer.byteLength(text);

// The one cap check: the tool and the user's save both go through it.
export function capped(text: string): Revised {
  const bytes = size(text);
  return bytes > NOTEBOOK_CAP
    ? { ok: false, reason: `The notebook would be ${bytes} of ${NOTEBOOK_CAP} bytes. Merge or remove entries, then edit again.`, show: false }
    : { ok: true, text };
}

// Exact-text edits, in order, all or none. Matching old text instead of overwriting is the concurrency check: an edit
// against a line the user has changed since the model last read it fails, and the user's words stay.
export function revise(text: string, edits: Edit[]): Revised {
  let result = text;
  for (const [n, edit] of edits.entries()) {
    const at = `Edit ${n + 1}: `;
    if (edit.old === "") {
      result = result === "" || result.endsWith("\n") ? result + edit.new : result + "\n" + edit.new;
      continue;
    }
    const count = result.split(edit.old).length - 1;
    if (count === 0) return { ok: false, reason: at + "Old text not found.", show: true };
    if (count > 1) return { ok: false, reason: at + `Old text occurs ${count} times. Give more context so it occurs once.`, show: true };
    result = result.replace(edit.old, () => edit.new);
  }
  return capped(result);
}

export function block(notebook: { revision: number; text: string }): string {
  if (notebook.text === "") return `<notebook revision="${notebook.revision}"/>\nYour notebook is empty. Add to it with notebook_edit when you learn something that will matter later.\n`;
  return `<notebook revision="${notebook.revision}">\n${notebook.text}${notebook.text.endsWith("\n") ? "" : "\n"}</notebook>\n`;
}

// "- " lines left the text and "+ " lines entered it. Equal lines at both ends are dropped, and the rest is matched by longest common subsequence.
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.split("\n"), b = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  const out: string[] = [];
  if (x.length * y.length > DIFF_WORK) {
    out.push(...x.map((line) => "- " + line), ...y.map((line) => "+ " + line));
    return out.join("\n");
  }
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
    else if (j >= y.length || i < x.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push("- " + x[i++]);
    else out.push("+ " + y[j++]);
  }
  return out.join("\n");
}

// The Log holds every revision as one record, so a replay restores the latest, a user save dedupes by its act id like any
// act, and one write per change leaves no crash window. The markdown is made on request: the Room route and export.
export class Notebook {
  readonly tools: NotebookTools;
  // Each user edit's diff, kept until an epoch is told. After a restart an epoch starts at the current revision, so none is needed.
  private readonly userDiffs: Array<{ revision: number; diff: string }> = [];

  constructor(private readonly log: Log, private readonly hooks: { record(entry: Entry): void; emit(event: NotebookEvent): void }) {
    this.tools = {
      edit: (edits) => {
        const current = this.current;
        const revised = revise(current.text, edits);
        if (!revised.ok) return { text: revised.reason + (revised.show ? "\nThe notebook is now:\n" + block(current) : ""), error: true };
        if (revised.text === current.text) return { text: `Notebook unchanged at revision ${current.revision}: ${size(current.text)} of ${NOTEBOOK_CAP} bytes.`, error: false };
        this.log.saveNotebook(revised.text, "agent", null);
        this.hooks.emit(this.event);
        const now = this.current;
        return { text: `Notebook revision ${now.revision}: ${size(now.text)} of ${NOTEBOOK_CAP} bytes.`, error: false };
      },
    };
  }

  get current(): { revision: number; text: string } { return this.log.notebook; }
  get event(): NotebookEvent { return { type: "notebook", notebook: this.log.notebook }; }
  get userRevision(): number { return this.log.notebookUser; }

  // What an epoch that has seen revision `from` is told about the user's edits since.
  notice(from: number): string {
    const pending = this.userDiffs.filter((edit) => edit.revision > from);
    const now = this.current;
    const diff = pending.map((edit) => edit.diff).join("\n");
    this.userDiffs.length = 0;
    const whole = size(diff) > NOTICE_LIMIT || pending.length === 0;
    return `the user changed the notebook to revision ${whole ? now.revision : pending.at(-1)!.revision}:\n` + (whole ? block(now) : diff);
  }

  act(act: NotebookAct): Answer {
    const previous = this.log.answer(act.id);
    if (previous) return previous;
    const current = this.current;
    const text = act.text.replace(/\r\n?/g, "\n");
    const checked = capped(text);
    const refusal = act.base !== current.revision
      ? `The notebook is at revision ${current.revision}, and you edited revision ${act.base}.`
      : checked.ok ? undefined : checked.reason;
    const changed = text !== current.text;
    const diff = changed ? lineDiff(current.text, text) : "";
    const { answer, entry } = this.log.saveNotebook(changed ? text : null, "user", act, {
      ...(refusal === undefined ? { note: `The user edited the notebook (revision ${current.revision + 1}):\n${diff}` } : { refusal }),
    });
    if (refusal === undefined && changed) {
      this.userDiffs.push({ revision: this.current.revision, diff });
      if (entry) this.hooks.record(entry);
      this.hooks.emit(this.event);
    }
    return answer!;
  }
}
