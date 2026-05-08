import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ProjectListing, Tool, ToolParam, ToolParamType, ToolProposal } from "../types";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Global Tools tab. Lists registered tools, lets the user create / edit /
 * archive them, and exposes a "Run" modal that spawns a tool-backed task
 * against any project. Run-now is the pragmatic shortcut — for scheduled
 * runs, the Cron tab wires the same target.
 *
 * UX choices:
 *   - All editing happens in modals so the list view stays uncluttered.
 *   - Param editing is per-row in the modal; we don't try to be too
 *     fancy with drag-reorder yet (low value at this scale).
 *   - The "category" pill is purely cosmetic — useful for grouping at a
 *     glance once a user accumulates more than ~5 tools.
 */

interface Props {
  tools: Tool[];
  projects: ProjectListing[];
  /** Phase 13: pending agent-emitted suggestions, rendered as a banner. */
  proposals: ToolProposal[];
  onApply: (envelope: unknown) => Promise<boolean>;
}

export function ToolsPanel({ tools, projects, proposals, onApply }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Tool | null>(null);
  const [running, setRunning] = useState<Tool | null>(null);
  // Phase 13: accept flow opens the editor pre-filled with the proposal
  // draft. We track which proposal is being accepted so the submit
  // handler dispatches `accept_tool_proposal` (with overrides) instead
  // of `create_tool`.
  const [accepting, setAccepting] = useState<ToolProposal | null>(null);

  const sorted = useMemo(
    () => [...tools].sort((a, b) => b.updated_at - a.updated_at),
    [tools],
  );
  const pending = useMemo(
    () => proposals.filter((p) => p.status === "pending"),
    [proposals],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>// tools</Text>
          <Text style={styles.headerTitle}>Reusable agent skills</Text>
          <Text style={styles.headerSub}>
            Author a prompt template once, run it against any project. Tools
            create tasks the queue executes.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setCreateOpen(true)}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
        >
          <Text style={styles.primaryBtnText}>+ NEW TOOL</Text>
        </Pressable>
      </View>

      {pending.length > 0 ? (
        <SuggestionsBanner
          proposals={pending}
          onAccept={(p) => setAccepting(p)}
          onReject={(p) =>
            void onApply({
              kind: "reject_tool_proposal",
              payload: { proposal_id: p.id },
            })
          }
        />
      ) : null}

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No tools yet.</Text>
          <Text style={styles.emptySub}>
            Tools are reusable cursor-agent prompts with declared params.
            Create one and run it against any project, or schedule it from
            the Cron tab.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {sorted.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              onRun={() => setRunning(tool)}
              onEdit={() => setEditing(tool)}
              onArchive={() =>
                void onApply({
                  kind: "archive_tool",
                  payload: { tool_id: tool.id },
                })
              }
            />
          ))}
        </ScrollView>
      )}

      <ToolEditorModal
        visible={createOpen}
        title="NEW TOOL"
        initial={null}
        onCancel={() => setCreateOpen(false)}
        onSubmit={async (draft) => {
          const ok = await onApply({ kind: "create_tool", payload: draft });
          if (ok) setCreateOpen(false);
        }}
      />

      <ToolEditorModal
        visible={!!editing}
        title={editing ? `EDIT ${editing.name.toUpperCase()}` : ""}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSubmit={async (draft) => {
          if (!editing) return;
          const ok = await onApply({
            kind: "update_tool",
            payload: { ...draft, tool_id: editing.id },
          });
          if (ok) setEditing(null);
        }}
      />

      <ToolEditorModal
        visible={!!accepting}
        title={accepting ? `ACCEPT SUGGESTION: ${accepting.name.toUpperCase()}` : ""}
        initial={null}
        seedDraft={accepting ? proposalToDraft(accepting) : null}
        onCancel={() => setAccepting(null)}
        onSubmit={async (draft) => {
          if (!accepting) return;
          // Server expects `overrides` shape that mirrors create_tool —
          // omit empty optional fields so they don't override the
          // proposal's values with empty strings.
          const overrides: Record<string, unknown> = {
            name: draft.name,
            prompt_template: draft.prompt_template,
            params: draft.params,
          };
          if (draft.slug) overrides.slug = draft.slug;
          if (draft.description) overrides.description = draft.description;
          if (draft.category) overrides.category = draft.category;
          const ok = await onApply({
            kind: "accept_tool_proposal",
            payload: { proposal_id: accepting.id, overrides },
          });
          if (ok) setAccepting(null);
        }}
      />

      <RunToolModal
        visible={!!running}
        tool={running}
        projects={projects}
        onCancel={() => setRunning(null)}
        onSubmit={async (payload) => {
          const ok = await onApply({ kind: "run_tool", payload });
          if (ok) setRunning(null);
        }}
      />
    </View>
  );
}

// ---- Single row in the list ----

function ToolRow({
  tool,
  onRun,
  onEdit,
  onArchive,
}: {
  tool: Tool;
  onRun: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const previewLines = tool.prompt_template.split("\n");
  const preview = previewLines.slice(0, 3).join("\n");
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{tool.name}</Text>
          {tool.category ? <Text style={styles.rowCategory}>{tool.category}</Text> : null}
          <Text style={styles.rowSlug} selectable>
            {`POST /v1/tools/${tool.slug}/run`}
          </Text>
        </View>
        {tool.description ? <Text style={styles.rowDesc}>{tool.description}</Text> : null}
        <Text style={styles.rowPreview} numberOfLines={3}>
          {preview}
          {previewLines.length > 3 ? "\n…" : ""}
        </Text>
        {tool.params.length > 0 ? (
          <View style={styles.paramRow}>
            {tool.params.map((p) => (
              <View key={p.name} style={styles.paramPill}>
                <Text style={styles.paramName}>{p.name}</Text>
                <Text style={styles.paramType}>{p.type}{p.required ? "*" : ""}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onRun}
          style={({ pressed }) => [styles.actionBtn, styles.actionBtnRun, pressed && styles.actionBtnPressed]}
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextRun]}>RUN</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onEdit}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={styles.actionBtnText}>EDIT</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onArchive}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>ARCHIVE</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Editor modal ----

interface DraftTool {
  name: string;
  /**
   * Optional URL slug. Empty in create mode means "let the server derive
   * one from name"; populated in edit mode to allow rename. The server
   * enforces uniqueness — collisions surface as a 409.
   */
  slug?: string;
  description?: string;
  category?: string;
  prompt_template: string;
  params: ToolParam[];
}

const PARAM_TYPES: ToolParamType[] = ["string", "text", "number", "boolean", "enum"];

function ToolEditorModal({
  visible,
  title,
  initial,
  seedDraft,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  initial: Tool | null;
  /**
   * Phase 13: optional pre-filled draft (used when accepting a tool
   * suggestion). Takes precedence over `initial`. We intentionally
   * accept a `DraftTool` rather than synthesizing a fake `Tool` so
   * the seed can be partial without lying about server-side fields
   * like `id` / timestamps.
   */
  seedDraft?: DraftTool | null;
  onCancel: () => void;
  onSubmit: (draft: DraftTool) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftTool>(blankDraft());

  // Re-seed the form when `initial` / `seedDraft` changes (open with
  // editing tool, accepted proposal, or new).
  useMemo(() => {
    if (seedDraft) setDraft(seedDraft);
    else if (initial) setDraft(toolToDraft(initial));
    else setDraft(blankDraft());
  }, [initial, seedDraft, visible]);

  const updateParam = (idx: number, patch: Partial<ToolParam>) => {
    setDraft((d) => {
      const params = d.params.slice();
      params[idx] = { ...params[idx], ...patch };
      return { ...d, params };
    });
  };

  const addParam = () => {
    setDraft((d) => ({
      ...d,
      params: [
        ...d.params,
        { name: `param${d.params.length + 1}`, type: "string", required: false },
      ],
    }));
  };

  const removeParam = (idx: number) => {
    setDraft((d) => ({ ...d, params: d.params.filter((_, i) => i !== idx) }));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Field
              label="NAME"
              value={draft.name}
              onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
            />
            <Field
              label={initial ? "SLUG" : "SLUG (optional — auto-derived from name)"}
              value={draft.slug ?? ""}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  slug: v
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/^-+|-+$/g, ""),
                }))
              }
              hint="Used in the callable HTTP API at POST /v1/tools/<slug>/run."
            />
            <Field
              label="CATEGORY (optional)"
              value={draft.category ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
            />
            <Field
              label="DESCRIPTION"
              value={draft.description ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
              multiline
              minHeight={48}
            />
            <Field
              label="PROMPT TEMPLATE"
              value={draft.prompt_template}
              onChange={(v) => setDraft((d) => ({ ...d, prompt_template: v }))}
              multiline
              minHeight={140}
              hint="Use {{var}} substitution. Optional: {{var | &quot;fallback&quot;}} or {{#var}}…{{/var}} blocks."
            />

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionLabel}>// params</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={addParam}
                  style={({ pressed }) => [styles.smallBtn, pressed && styles.smallBtnPressed]}
                >
                  <Text style={styles.smallBtnText}>+ ADD PARAM</Text>
                </Pressable>
              </View>
              {draft.params.length === 0 ? (
                <Text style={styles.helper}>
                  Tools without params are valid — they just hard-code their entire prompt.
                </Text>
              ) : (
                draft.params.map((p, idx) => (
                  <View key={idx} style={styles.paramEditor}>
                    <View style={styles.paramEditorRow}>
                      <Field
                        label="NAME"
                        value={p.name}
                        onChange={(v) => updateParam(idx, { name: v })}
                        compact
                      />
                      <View style={styles.paramTypePicker}>
                        <Text style={styles.fieldLabel}>TYPE</Text>
                        <View style={styles.typeRow}>
                          {PARAM_TYPES.map((t) => (
                            <Pressable
                              key={t}
                              onPress={() => updateParam(idx, { type: t })}
                              style={[
                                styles.typeChip,
                                p.type === t && styles.typeChipActive,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.typeChipText,
                                  p.type === t && styles.typeChipTextActive,
                                ]}
                              >
                                {t}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    </View>
                    <Field
                      label="LABEL (optional)"
                      value={p.label ?? ""}
                      onChange={(v) => updateParam(idx, { label: v })}
                      compact
                    />
                    <Field
                      label="DESCRIPTION (optional)"
                      value={p.description ?? ""}
                      onChange={(v) => updateParam(idx, { description: v })}
                      compact
                    />
                    <Field
                      label="DEFAULT (optional)"
                      value={p.default ?? ""}
                      onChange={(v) => updateParam(idx, { default: v })}
                      compact
                    />
                    {p.type === "enum" ? (
                      <Field
                        label="ENUM OPTIONS (comma-separated)"
                        value={(p.options ?? []).join(", ")}
                        onChange={(v) =>
                          updateParam(idx, {
                            options: v
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                        compact
                      />
                    ) : null}
                    <View style={styles.paramFooter}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => updateParam(idx, { required: !p.required })}
                        style={[
                          styles.requiredToggle,
                          p.required && styles.requiredToggleOn,
                        ]}
                      >
                        <Text
                          style={[
                            styles.requiredText,
                            p.required && styles.requiredTextOn,
                          ]}
                        >
                          {p.required ? "REQUIRED ✓" : "OPTIONAL"}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => removeParam(idx)}
                        style={({ pressed }) => [styles.smallBtn, pressed && styles.smallBtnPressed]}
                      >
                        <Text style={[styles.smallBtnText, { color: palette.danger }]}>
                          REMOVE
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ))
              )}
            </View>
          </ScrollView>
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
            >
              <Text style={styles.secondaryBtnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                // Strip empty optional fields so the server's optional
                // schema kicks in (empty string would fail validation
                // for the slug regex; auto-derive should win in that
                // case).
                const cleaned: DraftTool = { ...draft };
                if (!cleaned.slug) delete cleaned.slug;
                if (!cleaned.category) delete cleaned.category;
                if (!cleaned.description) delete cleaned.description;
                void onSubmit(cleaned);
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
            >
              <Text style={styles.primaryBtnText}>
                {initial ? "SAVE" : "CREATE"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function blankDraft(): DraftTool {
  return {
    name: "",
    slug: "",
    description: "",
    category: "",
    prompt_template: "",
    params: [],
  };
}

function toolToDraft(t: Tool): DraftTool {
  return {
    name: t.name,
    slug: t.slug,
    description: t.description ?? "",
    category: t.category ?? "",
    prompt_template: t.prompt_template,
    params: t.params.map((p) => ({ ...p })),
  };
}

function proposalToDraft(p: ToolProposal): DraftTool {
  return {
    name: p.name,
    // Slug is auto-derived at create-time unless the user types one in.
    slug: "",
    description: p.description ?? "",
    category: p.category ?? "",
    prompt_template: p.prompt_template,
    params: (p.params ?? []).map((q) => ({ ...q })),
  };
}

// ---- Suggestions banner (Phase 13) ----
//
// Pending suggestions render at the top of the Tools tab. Each row
// shows the proposed name, rationale, source project, and two actions:
//   ACCEPT → opens the tool editor pre-filled (user can tweak before
//            saving). On save we dispatch `accept_tool_proposal` which
//            both creates the Tool and stamps the proposal accepted.
//   REJECT → dispatches `reject_tool_proposal` (soft-delete; the row
//            disappears because the default view filters to pending).

function SuggestionsBanner({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: ToolProposal[];
  onAccept: (p: ToolProposal) => void;
  onReject: (p: ToolProposal) => void;
}) {
  return (
    <View style={suggestStyles.banner}>
      <View style={suggestStyles.bannerHeader}>
        <Text style={suggestStyles.bannerLabel}>// suggestions</Text>
        <Text style={suggestStyles.bannerTitle}>
          {proposals.length} pending tool {proposals.length === 1 ? "suggestion" : "suggestions"}
        </Text>
        <Text style={suggestStyles.bannerSub}>
          The agent flagged repeatable work it just did. Review and accept to
          turn it into a reusable tool.
        </Text>
      </View>
      {proposals.map((p) => (
        <View key={p.id} style={suggestStyles.row}>
          <View style={{ flex: 1 }}>
            <Text style={suggestStyles.rowName}>{p.name}</Text>
            {p.rationale ? (
              <Text style={suggestStyles.rowRationale}>{p.rationale}</Text>
            ) : null}
            {p.description ? (
              <Text style={suggestStyles.rowDesc} numberOfLines={2}>
                {p.description}
              </Text>
            ) : null}
            <Text style={suggestStyles.rowMeta}>
              from {p.source.kind}
              {p.source.project_slug ? ` · ${p.source.project_slug}` : ""}
              {(p.params?.length ?? 0) > 0 ? ` · ${p.params!.length} param${p.params!.length === 1 ? "" : "s"}` : ""}
            </Text>
          </View>
          <View style={suggestStyles.rowActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => onAccept(p)}
              style={({ pressed }) => [
                suggestStyles.acceptBtn,
                pressed && suggestStyles.acceptBtnPressed,
              ]}
            >
              <Text style={suggestStyles.acceptBtnText}>ACCEPT</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onReject(p)}
              style={({ pressed }) => [
                suggestStyles.rejectBtn,
                pressed && suggestStyles.rejectBtnPressed,
              ]}
            >
              <Text style={suggestStyles.rejectBtnText}>REJECT</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

const suggestStyles = StyleSheet.create({
  banner: {
    backgroundColor: palette.bgPanel,
    borderColor: palette.borderStrong,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: space.md,
    marginBottom: space.md,
    ...glow(palette.violetDim, 10),
  },
  bannerHeader: {
    marginBottom: space.sm,
  },
  bannerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.violet,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  bannerTitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "700",
    color: palette.textPrimary,
    marginBottom: 2,
  },
  bannerSub: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.textMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderSoft,
    gap: space.md,
  },
  rowName: {
    fontFamily: fonts.body,
    fontWeight: "600",
    fontSize: 13,
    color: palette.textPrimary,
    marginBottom: 2,
  },
  rowRationale: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.violet,
    marginBottom: 2,
  },
  rowDesc: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.textPrimary,
    marginBottom: 2,
  },
  rowMeta: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.textMuted,
    letterSpacing: 1,
  },
  rowActions: {
    flexDirection: "column",
    gap: space.xs,
  },
  acceptBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92,246,255,0.06)",
    ...glow(palette.cyanGlow, 10),
  },
  acceptBtnPressed: {
    backgroundColor: "rgba(92,246,255,0.14)",
  },
  acceptBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.cyan,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  rejectBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  rejectBtnPressed: {
    backgroundColor: "rgba(180,200,220,0.06)",
  },
  rejectBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.textSecondary,
    letterSpacing: 1.5,
    fontWeight: "500",
  },
});

// ---- Run modal ----

function RunToolModal({
  visible,
  tool,
  projects,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  tool: Tool | null;
  projects: ProjectListing[];
  onCancel: () => void;
  onSubmit: (payload: {
    tool_id: string;
    project_slug: string;
    args: Record<string, string>;
    auto_start: boolean;
  }) => Promise<void>;
}) {
  const [slug, setSlug] = useState<string>("");
  const [autoStart, setAutoStart] = useState(true);
  const [args, setArgs] = useState<Record<string, string>>({});

  useMemo(() => {
    if (!tool) return;
    const initial: Record<string, string> = {};
    for (const p of tool.params) initial[p.name] = p.default ?? "";
    setArgs(initial);
    setSlug(projects[0]?.slug ?? "");
    setAutoStart(true);
  }, [tool, visible, projects]);

  if (!tool) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>RUN: {tool.name.toUpperCase()}</Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            {tool.description ? (
              <Text style={styles.helper}>{tool.description}</Text>
            ) : null}

            <Text style={styles.fieldLabel}>PROJECT</Text>
            {projects.length === 0 ? (
              <Text style={styles.helper}>
                No projects yet — create one before running tools.
              </Text>
            ) : (
              <View style={styles.projectGrid}>
                {projects
                  .filter((p) => p.status !== "archived")
                  .map((p) => (
                    <Pressable
                      key={p.slug}
                      onPress={() => setSlug(p.slug)}
                      style={[
                        styles.projectChip,
                        slug === p.slug && styles.projectChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.projectChipText,
                          slug === p.slug && styles.projectChipTextActive,
                        ]}
                      >
                        {p.name}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            )}

            {tool.params.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>// args</Text>
                {tool.params.map((p) => (
                  <RunArgField
                    key={p.name}
                    param={p}
                    value={args[p.name] ?? ""}
                    onChange={(v) => setArgs((a) => ({ ...a, [p.name]: v }))}
                  />
                ))}
              </View>
            ) : (
              <Text style={styles.helper}>This tool takes no parameters.</Text>
            )}

            <Pressable
              accessibilityRole="button"
              onPress={() => setAutoStart((v) => !v)}
              style={[styles.requiredToggle, autoStart && styles.requiredToggleOn, { alignSelf: "flex-start" }]}
            >
              <Text style={[styles.requiredText, autoStart && styles.requiredTextOn]}>
                {autoStart ? "AUTO-START ✓" : "QUEUE ONLY"}
              </Text>
            </Pressable>
            <Text style={styles.helperSmall}>
              Auto-start dispatches the run on a free queue slot immediately. Otherwise, the task waits for the user to click Run on the queue.
            </Text>
          </ScrollView>
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
            >
              <Text style={styles.secondaryBtnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!slug}
              onPress={() =>
                void onSubmit({
                  tool_id: tool.id,
                  project_slug: slug,
                  args,
                  auto_start: autoStart,
                })
              }
              style={({ pressed }) => [
                styles.primaryBtn,
                !slug && styles.primaryBtnDisabled,
                pressed && styles.primaryBtnPressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>RUN</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function RunArgField({
  param,
  value,
  onChange,
}: {
  param: ToolParam;
  value: string;
  onChange: (v: string) => void;
}) {
  if (param.type === "enum" && param.options && param.options.length > 0) {
    return (
      <View style={{ marginBottom: space.md }}>
        <Text style={styles.fieldLabel}>
          {(param.label ?? param.name).toUpperCase()}
          {param.required ? " *" : ""}
        </Text>
        <View style={styles.typeRow}>
          {param.options.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[styles.typeChip, value === opt && styles.typeChipActive]}
            >
              <Text style={[styles.typeChipText, value === opt && styles.typeChipTextActive]}>
                {opt}
              </Text>
            </Pressable>
          ))}
        </View>
        {param.description ? <Text style={styles.helperSmall}>{param.description}</Text> : null}
      </View>
    );
  }
  if (param.type === "boolean") {
    const on = value === "true";
    return (
      <View style={{ marginBottom: space.md }}>
        <Text style={styles.fieldLabel}>
          {(param.label ?? param.name).toUpperCase()}
          {param.required ? " *" : ""}
        </Text>
        <Pressable
          onPress={() => onChange(on ? "false" : "true")}
          style={[styles.requiredToggle, on && styles.requiredToggleOn, { alignSelf: "flex-start" }]}
        >
          <Text style={[styles.requiredText, on && styles.requiredTextOn]}>
            {on ? "TRUE" : "FALSE"}
          </Text>
        </Pressable>
        {param.description ? <Text style={styles.helperSmall}>{param.description}</Text> : null}
      </View>
    );
  }
  return (
    <Field
      label={`${(param.label ?? param.name).toUpperCase()}${param.required ? " *" : ""}`}
      value={value}
      onChange={onChange}
      multiline={param.type === "text"}
      minHeight={param.type === "text" ? 80 : undefined}
      hint={param.description}
    />
  );
}

// ---- Field primitive ----

function Field({
  label,
  value,
  onChange,
  multiline,
  minHeight,
  hint,
  compact,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  minHeight?: number;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <View style={[styles.field, compact && styles.fieldCompact]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={!!multiline}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          minHeight ? { minHeight } : null,
        ]}
        placeholderTextColor={palette.textMuted}
      />
      {hint ? <Text style={styles.helperSmall}>{hint}</Text> : null}
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create({
  root: { flex: 1, padding: space.xl, gap: space.lg },

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.md,
  },
  headerLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  headerTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 2,
  },
  headerSub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 4,
    maxWidth: 480,
  },

  primaryBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92,246,255,0.06)",
    ...glow(palette.cyanGlow, 12),
  },
  primaryBtnPressed: { backgroundColor: "rgba(92,246,255,0.14)" },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "600",
  },

  secondaryBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  secondaryBtnPressed: { backgroundColor: "rgba(180,200,220,0.06)" },
  secondaryBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "500",
  },

  empty: {
    padding: space.xl,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  emptySub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    textAlign: "center",
    maxWidth: 380,
  },

  list: { gap: space.md, paddingBottom: space.xl },

  row: {
    flexDirection: "row",
    gap: space.md,
    padding: space.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: palette.bgPanel,
  },
  rowMain: { flex: 1, gap: 6 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  rowCategory: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: palette.violetDim,
    borderRadius: radii.sm,
  },
  rowSlug: {
    marginLeft: "auto",
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    opacity: 0.7,
  },
  rowDesc: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  rowPreview: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.18)",
    padding: 8,
    borderRadius: radii.sm,
  },
  paramRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  paramPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderHair,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  paramName: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  paramType: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
  },

  rowActions: { gap: 6, alignItems: "flex-end" },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    minWidth: 84,
    alignItems: "center",
  },
  actionBtnRun: {
    backgroundColor: "rgba(92,246,255,0.06)",
    borderColor: palette.borderStrong,
  },
  actionBtnPressed: { backgroundColor: "rgba(180,200,220,0.04)" },
  actionBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  actionBtnTextRun: { color: palette.cyan },
  actionBtnTextDanger: { color: palette.danger },

  // ---- Modal ----

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 720,
    maxHeight: "90%",
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderHair,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSoft,
  },
  modalTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1.6,
    fontWeight: "700",
  },
  modalClose: { color: palette.textMuted, fontSize: 22 },
  modalBody: {
    padding: space.lg,
    gap: space.md,
  },
  modalFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.16)",
  },

  field: { gap: 6 },
  fieldCompact: { flex: 1 },
  fieldLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.5,
  },
  input: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  inputMultiline: { textAlignVertical: "top" },
  helper: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  helperSmall: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  section: { gap: 8, marginTop: space.sm },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
  },

  smallBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  smallBtnPressed: { backgroundColor: "rgba(180,200,220,0.04)" },
  smallBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },

  paramEditor: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.14)",
  },
  paramEditorRow: { flexDirection: "row", gap: space.md },
  paramTypePicker: { flex: 1, gap: 6 },
  typeRow: { flexDirection: "row", gap: 4, flexWrap: "wrap" },
  typeChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  typeChipActive: {
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92,246,255,0.06)",
  },
  typeChipText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  typeChipTextActive: { color: palette.cyan },
  paramFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  requiredToggle: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  requiredToggleOn: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  requiredText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  requiredTextOn: { color: palette.cyan },

  projectGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: space.md },
  projectChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  projectChipActive: {
    borderColor: palette.violet,
    backgroundColor: "rgba(183,139,255,0.08)",
  },
  projectChipText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  projectChipTextActive: { color: palette.violet, fontWeight: "600" },
});
