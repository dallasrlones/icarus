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
import type { CronJob, ProjectListing, Tool } from "../types";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Global Cron tab. Lists scheduled jobs, lets the user create / archive
 * them, and exposes "run now" for ad-hoc firing without waiting for the
 * schedule. Targets are either a Tool (run a tool against a project on a
 * schedule) or the Queue (kick the queue worker on a schedule, scoped or
 * fleet-wide).
 *
 * Shape mirrors ToolsPanel — same modal patterns and field primitive —
 * but the form is simpler since cron jobs don't have per-job param
 * authoring (they pass args through to a tool that already declared them).
 */

interface Props {
  jobs: CronJob[];
  tools: Tool[];
  projects: ProjectListing[];
  onApply: (envelope: unknown) => Promise<boolean>;
}

export function CronPanel({ jobs, tools, projects, onApply }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CronJob | null>(null);

  const sorted = useMemo(
    () => [...jobs].sort((a, b) => b.updated_at - a.updated_at),
    [jobs],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>// cron</Text>
          <Text style={styles.headerTitle}>Scheduled jobs</Text>
          <Text style={styles.headerSub}>
            Schedules use standard 5-field crontab syntax. Targets are either
            a tool (parametrized cursor-agent run) or the queue worker.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setCreateOpen(true)}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
        >
          <Text style={styles.primaryBtnText}>+ NEW JOB</Text>
        </Pressable>
      </View>

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No scheduled jobs.</Text>
          <Text style={styles.emptySub}>
            Create one to automate recurring work — e.g. run a cleanup tool
            every night, or kick the queue every 15 minutes.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {sorted.map((job) => (
            <CronRow
              key={job.id}
              job={job}
              tools={tools}
              projects={projects}
              onEdit={() => setEditing(job)}
              onApply={onApply}
            />
          ))}
        </ScrollView>
      )}

      <CronEditorModal
        visible={createOpen}
        title="NEW CRON JOB"
        initial={null}
        tools={tools}
        projects={projects}
        onCancel={() => setCreateOpen(false)}
        onSubmit={async (draft) => {
          const ok = await onApply({ kind: "create_cron", payload: draft });
          if (ok) setCreateOpen(false);
        }}
      />

      <CronEditorModal
        visible={!!editing}
        title={editing ? `EDIT ${editing.name.toUpperCase()}` : ""}
        initial={editing}
        tools={tools}
        projects={projects}
        onCancel={() => setEditing(null)}
        onSubmit={async (draft) => {
          if (!editing) return;
          const ok = await onApply({
            kind: "update_cron",
            payload: { ...draft, cron_id: editing.id },
          });
          if (ok) setEditing(null);
        }}
      />
    </View>
  );
}

// ---- Single row ----

function CronRow({
  job,
  tools,
  projects,
  onEdit,
  onApply,
}: {
  job: CronJob;
  tools: Tool[];
  projects: ProjectListing[];
  onEdit: () => void;
  onApply: (envelope: unknown) => Promise<boolean>;
}) {
  const targetSummary = describeTarget(job, tools, projects);
  const stateLabel = job.enabled ? "ON" : "OFF";
  const lastRun = job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "—";
  const lastStatus = job.last_status ?? "—";
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{job.name}</Text>
          <Text style={[styles.statePill, job.enabled ? styles.statePillOn : styles.statePillOff]}>
            {stateLabel}
          </Text>
        </View>
        {job.description ? <Text style={styles.rowDesc}>{job.description}</Text> : null}
        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>SCHEDULE</Text>
            <Text style={styles.metaValueMono}>{job.schedule}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>TARGET</Text>
            <Text style={styles.metaValue}>{targetSummary}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>LAST RUN</Text>
            <Text style={styles.metaValue}>{lastRun}</Text>
            <Text style={[
              styles.metaSub,
              lastStatus === "ok" && { color: palette.green },
              lastStatus === "error" && { color: palette.danger },
            ]}>
              {lastStatus.toUpperCase()}
            </Text>
            {job.last_error ? (
              <Text style={styles.errorTail} numberOfLines={2}>
                {job.last_error}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void onApply({
              kind: "run_cron_now",
              payload: { cron_id: job.id },
            })
          }
          style={({ pressed }) => [styles.actionBtn, styles.actionBtnRun, pressed && styles.actionBtnPressed]}
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextRun]}>RUN NOW</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void onApply({
              kind: "set_cron_enabled",
              payload: { cron_id: job.id, enabled: !job.enabled },
            })
          }
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={styles.actionBtnText}>
            {job.enabled ? "DISABLE" : "ENABLE"}
          </Text>
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
          onPress={() =>
            void onApply({
              kind: "archive_cron",
              payload: { cron_id: job.id },
            })
          }
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>ARCHIVE</Text>
        </Pressable>
      </View>
    </View>
  );
}

function describeTarget(job: CronJob, tools: Tool[], projects: ProjectListing[]): string {
  const target = job.target;
  if (target.kind === "tool") {
    const tool = tools.find((t) => t.id === target.tool_id);
    const project = projects.find((p) => p.slug === target.project_slug);
    return `tool · ${tool?.name ?? target.tool_id} → ${project?.name ?? target.project_slug}`;
  }
  if (target.kind === "task") {
    const project = projects.find((p) => p.slug === target.project_slug);
    const startHint = target.auto_start ? " · auto-start" : "";
    return `task · "${target.title}" → ${project?.name ?? target.project_slug}${startHint}`;
  }
  return target.project_slug
    ? `queue · ${projects.find((p) => p.slug === target.project_slug)?.name ?? target.project_slug}`
    : "queue · fleet-wide";
}

// ---- Editor modal ----

interface DraftCron {
  name: string;
  description?: string;
  schedule: string;
  enabled: boolean;
  target:
    | { kind: "tool"; tool_id: string; project_slug: string; args?: Record<string, string>; priority?: number }
    | { kind: "queue"; project_slug?: string }
    | {
        kind: "task";
        project_slug: string;
        title: string;
        description?: string;
        priority?: number;
        feature_id?: string;
        auto_start?: boolean;
      };
}

const SCHEDULE_PRESETS: Array<{ label: string; expr: string; help: string }> = [
  { label: "every minute", expr: "* * * * *", help: "fires every minute (great for testing)" },
  { label: "every 5 min", expr: "*/5 * * * *", help: "every 5 minutes on the :00 :05 :10..." },
  { label: "hourly", expr: "0 * * * *", help: "top of every hour" },
  { label: "every 4 h", expr: "0 */4 * * *", help: "00:00, 04:00, 08:00 …" },
  { label: "daily 09:00", expr: "0 9 * * *", help: "every day at 9am" },
  { label: "weekly Mon 09:00", expr: "0 9 * * 1", help: "every Monday at 9am" },
];

function CronEditorModal({
  visible,
  title,
  initial,
  tools,
  projects,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  initial: CronJob | null;
  tools: Tool[];
  projects: ProjectListing[];
  onCancel: () => void;
  onSubmit: (draft: DraftCron) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftCron>(blankDraft());

  useMemo(() => {
    setDraft(initial ? cronToDraft(initial) : blankDraft());
  }, [initial, visible]);

  const target = draft.target;
  const tool =
    target.kind === "tool" ? tools.find((t) => t.id === target.tool_id) ?? null : null;

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
              label="DESCRIPTION (optional)"
              value={draft.description ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
              multiline
              minHeight={48}
            />

            <View style={styles.section}>
              <Text style={styles.sectionLabel}>// schedule</Text>
              <View style={styles.typeRow}>
                {SCHEDULE_PRESETS.map((p) => (
                  <Pressable
                    key={p.expr}
                    onPress={() => setDraft((d) => ({ ...d, schedule: p.expr }))}
                    style={[
                      styles.typeChip,
                      draft.schedule === p.expr && styles.typeChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.typeChipText,
                        draft.schedule === p.expr && styles.typeChipTextActive,
                      ]}
                    >
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Field
                label="EXPRESSION (5 fields: min hour day month dow)"
                value={draft.schedule}
                onChange={(v) => setDraft((d) => ({ ...d, schedule: v }))}
                hint="e.g. `0 */4 * * *` → every 4 hours on the hour."
              />
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionLabel}>// target</Text>
              <View style={styles.typeRow}>
                <Pressable
                  onPress={() =>
                    setDraft((d) => ({
                      ...d,
                      target: { kind: "tool", tool_id: tools[0]?.id ?? "", project_slug: projects[0]?.slug ?? "" },
                    }))
                  }
                  style={[
                    styles.typeChip,
                    draft.target.kind === "tool" && styles.typeChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      draft.target.kind === "tool" && styles.typeChipTextActive,
                    ]}
                  >
                    tool
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setDraft((d) => ({ ...d, target: { kind: "queue" } }))}
                  style={[
                    styles.typeChip,
                    draft.target.kind === "queue" && styles.typeChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      draft.target.kind === "queue" && styles.typeChipTextActive,
                    ]}
                  >
                    queue
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    setDraft((d) => ({
                      ...d,
                      target: {
                        kind: "task",
                        project_slug:
                          projects.find((p) => p.status !== "archived")?.slug ?? "",
                        title: "",
                        auto_start: false,
                      },
                    }))
                  }
                  style={[
                    styles.typeChip,
                    draft.target.kind === "task" && styles.typeChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      draft.target.kind === "task" && styles.typeChipTextActive,
                    ]}
                  >
                    task
                  </Text>
                </Pressable>
              </View>

              {draft.target.kind === "task" ? (
                <View style={{ gap: space.sm }}>
                  <Text style={styles.fieldLabel}>PROJECT</Text>
                  <View style={styles.typeRow}>
                    {projects
                      .filter((p) => p.status !== "archived")
                      .map((p) => (
                        <Pressable
                          key={p.slug}
                          onPress={() =>
                            setDraft((d) =>
                              d.target.kind === "task"
                                ? { ...d, target: { ...d.target, project_slug: p.slug, feature_id: undefined } }
                                : d,
                            )
                          }
                          style={[
                            styles.typeChip,
                            draft.target.kind === "task" && draft.target.project_slug === p.slug && styles.typeChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.typeChipText,
                              draft.target.kind === "task" && draft.target.project_slug === p.slug && styles.typeChipTextActive,
                            ]}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                  <Field
                    label="TITLE"
                    value={draft.target.kind === "task" ? draft.target.title : ""}
                    onChange={(v) =>
                      setDraft((d) =>
                        d.target.kind === "task" ? { ...d, target: { ...d.target, title: v } } : d,
                      )
                    }
                    hint="Task title — lands as-is in the backlog (no `cron:` prefix). Make it actionable: 'Triage open PRs', 'Run weekly backup', etc."
                  />
                  <Field
                    label="DESCRIPTION (optional)"
                    value={
                      draft.target.kind === "task"
                        ? draft.target.description ?? ""
                        : ""
                    }
                    onChange={(v) =>
                      setDraft((d) =>
                        d.target.kind === "task"
                          ? { ...d, target: { ...d.target, description: v } }
                          : d,
                      )
                    }
                    multiline
                    minHeight={60}
                  />
                  <Field
                    label="PRIORITY (optional, integer)"
                    value={
                      draft.target.kind === "task" && typeof draft.target.priority === "number"
                        ? String(draft.target.priority)
                        : ""
                    }
                    onChange={(v) =>
                      setDraft((d) => {
                        if (d.target.kind !== "task") return d;
                        const trimmed = v.trim();
                        if (!trimmed) return { ...d, target: { ...d.target, priority: undefined } };
                        const n = Number.parseInt(trimmed, 10);
                        return Number.isFinite(n)
                          ? { ...d, target: { ...d.target, priority: n } }
                          : d;
                      })
                    }
                    hint="Higher = sooner. Default 0."
                    compact
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setDraft((d) =>
                        d.target.kind === "task"
                          ? { ...d, target: { ...d.target, auto_start: !d.target.auto_start } }
                          : d,
                      )
                    }
                    style={[
                      styles.requiredToggle,
                      draft.target.kind === "task" && draft.target.auto_start && styles.requiredToggleOn,
                      { alignSelf: "flex-start" },
                    ]}
                  >
                    <Text
                      style={[
                        styles.requiredText,
                        draft.target.kind === "task" && draft.target.auto_start && styles.requiredTextOn,
                      ]}
                    >
                      {draft.target.kind === "task" && draft.target.auto_start
                        ? "AUTO-START ✓"
                        : "AUTO-START"}
                    </Text>
                  </Pressable>
                  <Text style={styles.helperSmall}>
                    {draft.target.kind === "task" && draft.target.auto_start
                      ? "On every tick: create the task and dispatch it on the queue immediately."
                      : "On every tick: create the task in the backlog as `todo` (you triage it manually)."}
                  </Text>
                </View>
              ) : draft.target.kind === "tool" ? (
                <>
                  <Text style={styles.fieldLabel}>TOOL</Text>
                  <View style={styles.typeRow}>
                    {tools.length === 0 ? (
                      <Text style={styles.helperSmall}>
                        No tools yet — create one on the Tools tab first.
                      </Text>
                    ) : (
                      tools.map((t) => (
                        <Pressable
                          key={t.id}
                          onPress={() =>
                            setDraft((d) =>
                              d.target.kind === "tool"
                                ? { ...d, target: { ...d.target, tool_id: t.id, args: {} } }
                                : d,
                            )
                          }
                          style={[
                            styles.typeChip,
                            draft.target.kind === "tool" && draft.target.tool_id === t.id && styles.typeChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.typeChipText,
                              draft.target.kind === "tool" && draft.target.tool_id === t.id && styles.typeChipTextActive,
                            ]}
                          >
                            {t.name}
                          </Text>
                        </Pressable>
                      ))
                    )}
                  </View>

                  <Text style={styles.fieldLabel}>PROJECT</Text>
                  <View style={styles.typeRow}>
                    {projects
                      .filter((p) => p.status !== "archived")
                      .map((p) => (
                        <Pressable
                          key={p.slug}
                          onPress={() =>
                            setDraft((d) =>
                              d.target.kind === "tool"
                                ? { ...d, target: { ...d.target, project_slug: p.slug } }
                                : d,
                            )
                          }
                          style={[
                            styles.typeChip,
                            draft.target.kind === "tool" && draft.target.project_slug === p.slug && styles.typeChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.typeChipText,
                              draft.target.kind === "tool" && draft.target.project_slug === p.slug && styles.typeChipTextActive,
                            ]}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                      ))}
                  </View>

                  {tool && tool.params.length > 0 ? (
                    <View style={{ gap: space.sm, marginTop: space.sm }}>
                      <Text style={styles.fieldLabel}>ARGS</Text>
                      {tool.params.map((p) => (
                        <Field
                          key={p.name}
                          label={`${(p.label ?? p.name).toUpperCase()}${p.required ? " *" : ""}`}
                          value={
                            draft.target.kind === "tool"
                              ? draft.target.args?.[p.name] ?? ""
                              : ""
                          }
                          onChange={(v) =>
                            setDraft((d) => {
                              if (d.target.kind !== "tool") return d;
                              return {
                                ...d,
                                target: {
                                  ...d.target,
                                  args: { ...(d.target.args ?? {}), [p.name]: v },
                                },
                              };
                            })
                          }
                          multiline={p.type === "text"}
                          minHeight={p.type === "text" ? 60 : undefined}
                          hint={p.description}
                          compact
                        />
                      ))}
                    </View>
                  ) : null}
                </>
              ) : (
                <View>
                  <Text style={styles.fieldLabel}>PROJECT (optional — leave empty for fleet-wide)</Text>
                  <View style={styles.typeRow}>
                    <Pressable
                      onPress={() => setDraft((d) => ({ ...d, target: { kind: "queue" } }))}
                      style={[
                        styles.typeChip,
                        draft.target.kind === "queue" && !draft.target.project_slug && styles.typeChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.typeChipText,
                          draft.target.kind === "queue" && !draft.target.project_slug && styles.typeChipTextActive,
                        ]}
                      >
                        fleet-wide
                      </Text>
                    </Pressable>
                    {projects
                      .filter((p) => p.status !== "archived")
                      .map((p) => (
                        <Pressable
                          key={p.slug}
                          onPress={() =>
                            setDraft((d) => ({
                              ...d,
                              target: { kind: "queue", project_slug: p.slug },
                            }))
                          }
                          style={[
                            styles.typeChip,
                            draft.target.kind === "queue" && draft.target.project_slug === p.slug && styles.typeChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.typeChipText,
                              draft.target.kind === "queue" && draft.target.project_slug === p.slug && styles.typeChipTextActive,
                            ]}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                </View>
              )}
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
              style={[styles.requiredToggle, draft.enabled && styles.requiredToggleOn, { alignSelf: "flex-start" }]}
            >
              <Text style={[styles.requiredText, draft.enabled && styles.requiredTextOn]}>
                {draft.enabled ? "ENABLED ✓" : "DISABLED"}
              </Text>
            </Pressable>
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
              onPress={() => void onSubmit(draft)}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
            >
              <Text style={styles.primaryBtnText}>{initial ? "SAVE" : "CREATE"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function blankDraft(): DraftCron {
  return {
    name: "",
    description: "",
    schedule: "0 * * * *",
    enabled: true,
    target: { kind: "queue" },
  };
}

function cronToDraft(j: CronJob): DraftCron {
  return {
    name: j.name,
    description: j.description ?? "",
    schedule: j.schedule,
    enabled: j.enabled,
    target: j.target,
  };
}

// ---- Field primitive (mirrors ToolsPanel intentionally to keep this file self-contained) ----

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
  rowMain: { flex: 1, gap: 8 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  statePill: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  statePillOn: {
    color: palette.green,
    borderColor: "rgba(118,245,176,0.4)",
    backgroundColor: "rgba(118,245,176,0.06)",
  },
  statePillOff: {
    color: palette.textMuted,
    borderColor: palette.borderSoft,
  },
  rowDesc: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  metaRow: { flexDirection: "row", gap: space.lg, flexWrap: "wrap" },
  metaCell: { gap: 2, minWidth: 140 },
  metaLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  metaValue: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 12 },
  metaValueMono: { color: palette.textPrimary, fontFamily: fonts.mono, fontSize: 12 },
  metaSub: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1 },
  errorTail: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 10,
    marginTop: 2,
  },

  rowActions: { gap: 6, alignItems: "flex-end" },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    minWidth: 96,
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
  modalBody: { padding: space.lg, gap: space.md },
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
  helperSmall: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  section: { gap: 8, marginTop: space.sm },
  sectionLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
  },

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
});
