import type { Tool, ToolParam } from "../domain.js";

/**
 * Mustache-lite template renderer for Tool prompts.
 *
 * Supported syntax (and intentionally nothing else — we want auditable
 * prompts, not a templating language):
 *
 *   {{name}}                substitute the named variable (HTML-unsafe;
 *                           prompts go to an LLM, not a browser)
 *   {{name | "fallback"}}   literal-string fallback when name is empty
 *   {{#name}}…{{/name}}     conditional block; included only when name is
 *                           a truthy / non-empty string. Cannot nest.
 *
 * Unknown variables are rendered as the empty string (and trigger a
 * warning collected in the result). The caller decides whether to treat
 * a warning as an error — applicators reject on missing required params
 * up front, so by the time a render runs the inputs are well-formed.
 *
 * We accept arguments as `Record<string, string>` because that's what
 * the over-the-wire payload carries. The renderer coerces to typed
 * params via `coerceArgs` so number / boolean params surface as the
 * obvious literal in prompts (`true`, `42`) rather than a JSON-stringy
 * mess.
 */

export interface RenderResult {
  text: string;
  /** Variables the template referenced that weren't supplied. */
  missing: string[];
}

/**
 * Coerce loose `Record<string, string>` args to per-param-type-aware
 * strings, applying defaults and validating enums. Throws on:
 *   - missing required params
 *   - enum value not in `options`
 *   - non-numeric input for `type: "number"`
 *   - non-boolean-ish input for `type: "boolean"`
 */
export function coerceArgs(
  params: ToolParam[],
  args: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const raw = args[p.name];
    const value = raw !== undefined && raw !== "" ? raw : p.default ?? "";
    if (!value) {
      if (p.required) throw new Error(`missing required param: ${p.name}`);
      out[p.name] = "";
      continue;
    }
    switch (p.type) {
      case "string":
      case "text":
        out[p.name] = value;
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new Error(`param ${p.name} expects a number, got "${value}"`);
        }
        out[p.name] = String(n);
        break;
      }
      case "boolean": {
        const v = value.toLowerCase();
        if (v === "true" || v === "1" || v === "yes") out[p.name] = "true";
        else if (v === "false" || v === "0" || v === "no") out[p.name] = "false";
        else throw new Error(`param ${p.name} expects a boolean, got "${value}"`);
        break;
      }
      case "enum":
        if (!p.options || !p.options.includes(value)) {
          throw new Error(
            `param ${p.name} must be one of ${p.options?.join(", ") ?? "(no options)"}, got "${value}"`,
          );
        }
        out[p.name] = value;
        break;
    }
  }
  return out;
}

/**
 * Render a tool's `prompt_template` against coerced args. Returns the
 * filled template plus any unresolved variables (variables the template
 * referenced but `args` doesn't supply — typically a sign the tool
 * declares fewer params than it uses, which the caller can warn about).
 */
export function renderTool(tool: Tool, args: Record<string, string>): RenderResult {
  const missing: string[] = [];
  let text = tool.prompt_template;

  // 1. Conditional blocks: {{#name}}…{{/name}}.
  //    Block content rendered only when args[name] is non-empty.
  text = text.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, name: string, body: string) => {
      const v = args[name];
      return v && v.length > 0 ? body : "";
    },
  );

  // 2. Variable substitutions, with optional fallback string.
  //    {{name}} or {{name | "fallback string"}}.
  text = text.replace(
    /\{\{\s*(\w+)(?:\s*\|\s*"([^"]*)")?\s*\}\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const v = args[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      // Track unresolved references so the caller can warn.
      if (!missing.includes(name)) missing.push(name);
      return "";
    },
  );

  return { text, missing };
}

/**
 * Build the queue-worker prompt for a Tool-backed task. We compose the
 * user-authored template with the standard task-execution scaffolding so
 * the agent still knows about the terminal verbs (`complete_task`,
 * `enqueue_question`, `fail_task`) and the project context.
 *
 * The header contains the concrete task / project / workspace info; the
 * "Tool prompt" section contains the rendered template verbatim so the
 * tool author's intent reads like a system message inside the run.
 */
export function buildToolTaskPrompt(input: {
  tool: Tool;
  args: Record<string, string>;
  projectSlug: string;
  workspacePath: string | null | undefined;
  task: { id: string; title: string; description?: string };
}): string {
  const { tool, args, projectSlug, workspacePath, task } = input;
  const rendered = renderTool(tool, args);

  const lines: string[] = [
    "[icarus tool runner]",
    "",
    `You are running the tool \`${tool.name}\` against project \`${projectSlug}\`.`,
    "Use cursor-agent's built-in tools (read, grep, edit, run) inside the",
    "workspace below. When you're done — or if you can't finish without user",
    "input — emit ONE terminal command block.",
    "",
    "Wire format (anchored at line start):",
    "```icarus",
    '{ "kind": "<verb>", "payload": { ... } }',
    "```",
    "",
    "Terminal verbs (emit exactly one before you stop):",
    "  complete_task    { project_slug, task_id, summary, artifacts? }",
    "  enqueue_question { project_slug, task_id, body, options? }",
    "  fail_task        { project_slug, task_id, reason }",
    "",
    "Context:",
    `  project_slug: ${projectSlug}`,
    `  workspace:    ${workspacePath ?? "(planning-only — no workspace path; you cannot edit files)"}`,
    `  task_id:      ${task.id}`,
    `  task_title:   ${task.title}`,
  ];
  if (task.description) lines.push(`  task_desc:    ${task.description}`);

  if (Object.keys(args).length > 0) {
    lines.push("", "Tool args:");
    for (const [k, v] of Object.entries(args)) {
      lines.push(`  ${k} = ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`);
    }
  }

  lines.push("", "------ Tool prompt (authored by the tool's creator) ------", rendered.text, "------ end tool prompt ------", "");

  if (rendered.missing.length > 0) {
    lines.push(
      `(note: the template references ${rendered.missing
        .map((m) => `\`{{${m}}}\``)
        .join(", ")} but no value was supplied; rendered as empty.)`,
    );
  }

  lines.push("Begin. Emit your terminal block when finished.");
  lines.push("[end icarus tool runner]");
  return lines.join("\n");
}
