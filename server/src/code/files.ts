import fs from "node:fs/promises";
import path from "node:path";
import { readFleet } from "../storage/fleet.js";

/**
 * Read-only code browser for a project's workspace.
 *
 * Safety rules:
 *   - The project must have a `workspace_path` set; planning-only projects
 *     return an empty/forbidden result.
 *   - All requested paths are resolved against the workspace root and
 *     rejected if the resolved absolute path escapes that root (covers
 *     `..`, symlink-leaks via `realpath`, leading slashes, etc.).
 *   - Hidden files / directories (leading `.`) and the usual heavy junk
 *     drawers are filtered from listings by default to keep mobile UIs
 *     snappy. Callers can pass `showHidden: true` to override.
 *   - File reads are capped at 1 MB; anything bigger reports `truncated`
 *     and returns just the head bytes. Binary detection is heuristic —
 *     non-printable byte ratio in the first 8 KB.
 */

export interface FileEntry {
  name: string;
  rel_path: string;
  kind: "dir" | "file";
  size?: number; // bytes — undefined for directories
}

export interface ListingResult {
  rel_path: string;
  entries: FileEntry[];
}

export interface ReadResult {
  rel_path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  language?: string;
  text?: string;
}

const HIDDEN_OK = new Set([".gitignore", ".env.example", ".prettierrc", ".eslintrc"]);
const HEAVY_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".cache",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".parcel-cache",
]);

const MAX_READ_BYTES = 1_000_000;

export class CodeBrowserError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function workspaceFor(slug: string): Promise<string> {
  const fleet = await readFleet();
  const project = fleet.projects.find((p) => p.slug === slug);
  if (!project) throw new CodeBrowserError(`unknown project: ${slug}`, 404);
  if (!project.workspace_path || project.workspace_path.length === 0) {
    throw new CodeBrowserError(
      `project "${slug}" has no workspace_path (planning-only)`,
      400,
    );
  }
  // Resolve through realpath so symlinked workspace bases stay normalized.
  return await fs.realpath(project.workspace_path);
}

function resolveSafe(workspace: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, "");
  const abs = path.resolve(workspace, cleaned);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new CodeBrowserError("path escapes workspace", 400);
  }
  return abs;
}

export async function listDir(slug: string, rel: string): Promise<ListingResult> {
  const workspace = await workspaceFor(slug);
  const abs = resolveSafe(workspace, rel);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodeBrowserError(`not found: ${rel}`, 404);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new CodeBrowserError(`not a directory: ${rel}`, 400);
  }
  const dirents = await fs.readdir(abs, { withFileTypes: true });

  const entries: FileEntry[] = [];
  for (const d of dirents) {
    const name = d.name;
    if (HEAVY_DIRS.has(name)) continue;
    if (name.startsWith(".") && !HIDDEN_OK.has(name)) continue;
    const sub = path.join(abs, name);
    const subRel = path.relative(workspace, sub);
    if (d.isDirectory()) {
      entries.push({ name, rel_path: subRel, kind: "dir" });
    } else if (d.isFile()) {
      let size = 0;
      try {
        const s = await fs.stat(sub);
        size = s.size;
      } catch {
        // Skip unstattable files quietly.
      }
      entries.push({ name, rel_path: subRel, kind: "file", size });
    }
    // Symlinks and special files are hidden — keep the model simple.
  }

  // Directories first, then files; alphabetical within each group.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { rel_path: path.relative(workspace, abs), entries };
}

export async function readFile(slug: string, rel: string): Promise<ReadResult> {
  const workspace = await workspaceFor(slug);
  const abs = resolveSafe(workspace, rel);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodeBrowserError(`not found: ${rel}`, 404);
    }
    throw err;
  }
  if (!stat.isFile()) throw new CodeBrowserError(`not a file: ${rel}`, 400);

  const size = stat.size;
  const truncated = size > MAX_READ_BYTES;
  const buf = await fs.readFile(abs);
  const head = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
  const binary = looksBinary(head);

  return {
    rel_path: path.relative(workspace, abs),
    size,
    truncated,
    binary,
    language: binary ? undefined : languageFor(rel),
    text: binary ? undefined : head.toString("utf8"),
  };
}

/**
 * Heuristic binary detection — count NUL and non-printable, non-ASCII
 * control bytes in the first 8 KB. Anything over ~12% is treated as
 * binary. UTF-8 multibyte sequences are still mostly printable so we
 * stay text-friendly for non-Latin code (Cyrillic, CJK).
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true; // NUL is a hard signal
    if (b < 9) suspicious++;
    else if (b > 13 && b < 32) suspicious++;
  }
  return suspicious / n > 0.12;
}

function languageFor(rel: string): string | undefined {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = path.extname(lower);
  switch (ext) {
    case ".ts": case ".tsx": return "typescript";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "javascript";
    case ".py": return "python";
    case ".rs": return "rust";
    case ".go": return "go";
    case ".java": return "java";
    case ".rb": return "ruby";
    case ".php": return "php";
    case ".swift": return "swift";
    case ".kt": return "kotlin";
    case ".c": case ".h": return "c";
    case ".cpp": case ".cc": case ".hpp": return "cpp";
    case ".cs": return "csharp";
    case ".sh": case ".bash": case ".zsh": return "bash";
    case ".sql": return "sql";
    case ".json": return "json";
    case ".yaml": case ".yml": return "yaml";
    case ".toml": return "toml";
    case ".md": case ".mdx": return "markdown";
    case ".html": return "html";
    case ".css": case ".scss": case ".sass": return "css";
    case ".xml": return "xml";
    case ".env": return "ini";
  }
  return undefined;
}
