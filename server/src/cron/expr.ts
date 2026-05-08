// Tiny crontab-expression matcher.
//
// Standard 5-field syntax: "<minute> <hour> <day-of-month> <month> <dow>".
//
// Per field we accept:
//   - "*"            any value
//   - "N"            single integer in the field's range
//   - "N1,N2,..."    comma list
//   - "N1-N2"        inclusive range
//   - "*\/step"      stride from the field's lower bound (e.g. *\/5 minute)
//   - "lo-hi/step"   strided range
//
// Day-of-week: 0 = Sunday, 6 = Saturday (also accepts 7 -> 0, common
// shorthand). Month: 1 = January, 12 = December. We do NOT accept names
// like MON or JAN to keep the parser tiny — names are easy to add later
// if anyone asks.
//
// matches(date, expr) returns true iff every field includes the
// corresponding component of date. The scheduler calls this once per
// job per minute tick.
//
// parse() validates and returns a parsed shape; throws on malformed
// input. We invoke it eagerly when a cron job is created so the user
// sees the error immediately, not at 3am the next day.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 6 }, // 7 normalized to 0 below
] as const;

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

export function parse(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 space-separated fields, got ${parts.length} ("${expr}")`,
    );
  }
  const [minute, hour, day, month, dow] = parts;
  return {
    minute: parseField(minute, FIELDS[0]),
    hour: parseField(hour, FIELDS[1]),
    day: parseField(day, FIELDS[2]),
    month: parseField(month, FIELDS[3]),
    dow: parseField(dow, FIELDS[4], (n) => (n === 7 ? 0 : n)),
  };
}

export function matches(date: Date, parsed: ParsedCron): boolean {
  return (
    parsed.minute.has(date.getMinutes()) &&
    parsed.hour.has(date.getHours()) &&
    parsed.day.has(date.getDate()) &&
    parsed.month.has(date.getMonth() + 1) &&
    parsed.dow.has(date.getDay())
  );
}

/**
 * Convenience wrapper: parse on demand and match. Used by the scheduler
 * inside the per-tick loop so an invalid expression on one job doesn't
 * crash the rest. Returns false (and surfaces the parse error to the
 * caller's optional onError) on bad input.
 */
export function safeMatches(
  date: Date,
  expr: string,
  onError?: (err: Error) => void,
): boolean {
  try {
    return matches(date, parse(expr));
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

function parseField(
  raw: string,
  field: { name: string; min: number; max: number },
  normalize?: (n: number) => number,
): Set<number> {
  if (raw === "*") return rangeSet(field.min, field.max, 1, normalize);

  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error(`empty term in ${field.name} field: "${raw}"`);
    }

    // step form: "<spec>/<n>"
    const stepIdx = trimmed.indexOf("/");
    let base = trimmed;
    let step = 1;
    if (stepIdx >= 0) {
      base = trimmed.slice(0, stepIdx);
      const stepRaw = trimmed.slice(stepIdx + 1);
      const stepN = Number(stepRaw);
      if (!Number.isInteger(stepN) || stepN < 1) {
        throw new Error(`invalid step in ${field.name}: "${stepRaw}"`);
      }
      step = stepN;
    }

    if (base === "*" || base === "") {
      // step over the full range
      for (const n of rangeSet(field.min, field.max, step, normalize)) {
        out.add(n);
      }
      continue;
    }

    const dashIdx = base.indexOf("-");
    if (dashIdx >= 0) {
      const lo = Number(base.slice(0, dashIdx));
      const hi = Number(base.slice(dashIdx + 1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        throw new Error(`invalid range in ${field.name}: "${base}"`);
      }
      assertInBounds(lo, field);
      assertInBounds(hi, field);
      for (const n of rangeSet(lo, hi, step, normalize)) out.add(n);
      continue;
    }

    const single = Number(base);
    if (!Number.isInteger(single)) {
      throw new Error(`invalid value in ${field.name}: "${base}"`);
    }
    assertInBounds(single, field);
    out.add(normalize ? normalize(single) : single);
  }

  if (out.size === 0) throw new Error(`no values produced for ${field.name}: "${raw}"`);
  return out;
}

function assertInBounds(n: number, field: { name: string; min: number; max: number }): void {
  // dow accepts 7 as an alias for 0; normalize handles the conversion.
  const upperBound = field.name === "dow" ? 7 : field.max;
  if (n < field.min || n > upperBound) {
    throw new Error(`${field.name} value out of range (${field.min}-${field.max}): ${n}`);
  }
}

function rangeSet(
  lo: number,
  hi: number,
  step: number,
  normalize?: (n: number) => number,
): Set<number> {
  const out = new Set<number>();
  for (let n = lo; n <= hi; n += step) {
    out.add(normalize ? normalize(n) : n);
  }
  return out;
}
