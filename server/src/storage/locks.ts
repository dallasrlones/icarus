/**
 * Per-key promise-chain mutex. Used for project-scoped serialization of
 * mutations and for chat-file writes so concurrent turns can't corrupt
 * each other.
 *
 * Single-process only. If we ever multi-process the server, we'll need a
 * filesystem advisory lock — but mutations are cheap and we're nowhere
 * near needing that.
 *
 * Crucially, the chain stored in the map *swallows* rejections so that a
 * thrown `fn` doesn't surface as an unhandled-rejection on a chain nobody
 * awaits. The caller still gets the original error via the returned
 * promise.
 */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result: Promise<T> = prev.then(() => fn(), () => fn());
    const tail: Promise<unknown> = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }
}

export const projectLocks = new KeyedMutex();
export const chatLocks = new KeyedMutex();
/**
 * Single-key locks for the global registries (tools.json, cron.json).
 * They live at the store root rather than under a slug, so projectLocks
 * doesn't apply. Calls always pass the same key (`"tools"` / `"cron"`)
 * and serialize accordingly.
 */
export const globalLocks = new KeyedMutex();
