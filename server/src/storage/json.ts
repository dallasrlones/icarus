import fs from "node:fs/promises";
import path from "node:path";

/**
 * Atomic JSON read/write helpers. Writes go to a sibling `.tmp` and then
 * `rename` over the target so a crash mid-write never leaves a half-file.
 */

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (isNotFound(err)) return fallback;
    throw err;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(value) + "\n", "utf8");
}

export async function rm(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err: unknown) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function isNotFound(err: unknown): boolean {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === "ENOENT";
}
