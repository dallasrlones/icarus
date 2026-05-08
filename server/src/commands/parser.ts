/**
 * Streaming fence parser for `icarus` command blocks.
 *
 * The agent emits commands inside markdown-fenced JSON blocks tagged
 * `icarus`:
 *
 *     ```icarus
 *     { "kind": "create_project", "payload": { "name": "Demo" } }
 *     ```
 *
 * As assistant deltas stream in, we hide the fence content from the user-
 * facing text stream and surface it as structured pill events instead.
 *
 * The parser is a tiny state machine that tolerates fences arriving across
 * arbitrary delta boundaries. It holds back any tail bytes that *could* be
 * the start of an opener/closer until enough context arrives to decide.
 *
 * Boundary rules:
 *   - The opener is `` ```icarus `` followed by a newline, anchored at the
 *     start of the buffer or after a `\n`.
 *   - The closer is `` ``` `` followed by a newline, anchored at the start
 *     of the buffer or after a `\n`.
 *
 * Anything else in the stream (regular text, other fenced code blocks like
 * ```bash) passes through untouched as `text` events.
 */

const OPEN = "```icarus\n";
const CLOSE = "```\n";

export type ParserEvent =
  | { type: "text"; text: string }
  | { type: "pill_open"; id: string }
  | { type: "pill_close"; id: string; body: string };

export class FenceParser {
  private buffer = "";
  private mode: "out" | "in" = "out";
  private fenceBody = "";
  private currentId: string | null = null;
  private idCounter = 0;

  feed(delta: string): ParserEvent[] {
    this.buffer += delta;
    const events: ParserEvent[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (this.mode === "out") progressed = this.stepOut(events);
      else progressed = this.stepIn(events);
    }
    return events;
  }

  /**
   * Flush remaining buffer at end of stream.
   *
   * A trailing closer with no terminating newline (e.g. the model ends its
   * reply with ``` and stops) won't have been detected by `stepIn` — its
   * regex requires ```\n. Strip a trailing line-anchored ``` here so the
   * pill body is clean JSON.
   *
   * If the fence is genuinely unclosed (no closer at all), we still emit
   * a pill_close so the UI can render a rejected state.
   */
  end(): ParserEvent[] {
    const events: ParserEvent[] = [];
    if (this.mode === "in") {
      const merged = this.fenceBody + this.buffer;
      const cleaned = stripTrailingCloser(merged);
      events.push({
        type: "pill_close",
        id: this.currentId!,
        body: cleaned.trim(),
      });
      this.fenceBody = "";
      this.buffer = "";
      this.currentId = null;
      this.mode = "out";
    } else if (this.buffer.length > 0) {
      events.push({ type: "text", text: this.buffer });
      this.buffer = "";
    }
    return events;
  }

  private stepOut(events: ParserEvent[]): boolean {
    const idx = findOpener(this.buffer);
    if (idx === -1) {
      const hold = tailHold(this.buffer, OPEN);
      const flushUntil = this.buffer.length - hold;
      if (flushUntil > 0) {
        events.push({ type: "text", text: this.buffer.slice(0, flushUntil) });
        this.buffer = this.buffer.slice(flushUntil);
        return true;
      }
      return false;
    }
    if (idx > 0) {
      events.push({ type: "text", text: this.buffer.slice(0, idx) });
    }
    this.buffer = this.buffer.slice(idx + OPEN.length);
    this.mode = "in";
    this.currentId = `pill_${++this.idCounter}_${Date.now().toString(36)}`;
    this.fenceBody = "";
    events.push({ type: "pill_open", id: this.currentId });
    return true;
  }

  private stepIn(events: ParserEvent[]): boolean {
    const idx = findCloser(this.buffer);
    if (idx === -1) {
      const hold = tailHold(this.buffer, CLOSE);
      const flushUntil = this.buffer.length - hold;
      if (flushUntil > 0) {
        this.fenceBody += this.buffer.slice(0, flushUntil);
        this.buffer = this.buffer.slice(flushUntil);
        return true;
      }
      return false;
    }
    this.fenceBody += this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + CLOSE.length);
    const id = this.currentId!;
    const body = this.fenceBody.trim();
    this.currentId = null;
    this.fenceBody = "";
    this.mode = "out";
    events.push({ type: "pill_close", id, body });
    return true;
  }
}

function findOpener(buf: string): number {
  return findAnchored(buf, OPEN);
}

function findCloser(buf: string): number {
  return findAnchored(buf, CLOSE);
}

function findAnchored(buf: string, needle: string): number {
  let from = 0;
  while (true) {
    const at = buf.indexOf(needle, from);
    if (at < 0) return -1;
    if (at === 0 || buf[at - 1] === "\n") return at;
    from = at + 1;
  }
}

/**
 * If `buf` ends with a (possibly partial) line-anchored prefix of `needle`,
 * return how many trailing chars to hold back. Otherwise 0.
 */
function tailHold(buf: string, needle: string): number {
  const max = Math.min(buf.length, needle.length - 1);
  for (let n = max; n > 0; n--) {
    const tail = buf.slice(buf.length - n);
    if (!needle.startsWith(tail)) continue;
    const start = buf.length - n;
    if (start === 0 || buf[start - 1] === "\n") return n;
  }
  return 0;
}

/**
 * Remove a line-anchored trailing ``` (with optional whitespace) from the
 * end of a fence body. Used at end-of-stream when the model didn't emit a
 * trailing newline after the closer.
 */
function stripTrailingCloser(s: string): string {
  // Match ``` at the very end, possibly with trailing whitespace, anchored
  // either at the start of the buffer or right after a newline (so we
  // don't accidentally strip an inline ``` that's part of the JSON body).
  const m = s.match(/(?:^|\n)```\s*$/);
  if (!m) return s;
  return s.slice(0, s.length - m[0].length);
}
