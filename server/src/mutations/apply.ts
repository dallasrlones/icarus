import { events } from "../events.js";
import { appendActivity } from "../storage/activity.js";
import { apply as runApplicator, ApplicatorError, type ApplyContext } from "./applicators.js";
import { parseEnvelope } from "./schema.js";

/**
 * Public mutation entry point. Validates the envelope, dispatches to the
 * applicator, persists an activity row, and broadcasts the event.
 *
 * Returns a typed Result so the HTTP handler can map directly to a
 * status code without having to know about the applicator internals.
 */

export type Result =
  | { ok: true; kind: string; result: unknown }
  | { ok: false; status: number; error: string };

export async function applyMutation(input: unknown, ctx: ApplyContext): Promise<Result> {
  const parsed = parseEnvelope(input);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }
  const envelope = parsed.envelope;

  let outcome;
  try {
    outcome = await runApplicator(envelope, ctx);
  } catch (err) {
    if (err instanceof ApplicatorError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }

  const ts = Date.now();
  await appendActivity({
    ts,
    kind: envelope.kind,
    scope: outcome.scope,
    payload: envelope.payload,
    result: outcome.result,
  });

  events.broadcast({
    type: "mutation_applied",
    kind: envelope.kind,
    payload: envelope.payload,
    result: outcome.result,
    ts,
  });

  return { ok: true, kind: envelope.kind, result: outcome.result };
}
