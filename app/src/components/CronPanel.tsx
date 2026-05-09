import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { CronJob, CronRun, ProjectListing, Tool } from "../types";
import {
  listCronFiles,
  listCronRuns,
  readCronFile,
  readCronTranscript,
  type CodeFile,
  type CodeFileEntry,
  type CodeListing,
} from "../api";
import { useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
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
  // Phase 23: per-cron file/run viewers. We track the cron job id so
  // the modal stays open across cron list refreshes (the row mutates
  // last_run_at every minute when a tick fires).
  const [filesOpen, setFilesOpen] = useState<CronJob | null>(null);
  const [runsOpen, setRunsOpen] = useState<CronJob | null>(null);

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
            Schedules use standard 5-field crontab syntax. Targets: standalone (own
            workspace under _cron, no project), tool or task (need a project), or
            the queue worker.
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
            Standalone jobs get their own folder and FILES / RUNS in the row.
            Or schedule a tool, task, or the queue worker when you use projects.
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
              onOpenFiles={() => setFilesOpen(job)}
              onOpenRuns={() => setRunsOpen(job)}
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
          const ok = await onApply({
            kind: "create_cron",
            payload: draftToWire(draft),
          });
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
          const wire = draftToWire(draft) as Record<string, unknown>;
          const ok = await onApply({
            kind: "update_cron",
            payload: { ...wire, cron_id: editing.id },
          });
          if (ok) setEditing(null);
        }}
      />

      <CronFilesModal
        cron={filesOpen}
        onClose={() => setFilesOpen(null)}
      />
      <CronRunsModal
        cron={runsOpen}
        onClose={() => setRunsOpen(null)}
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
  onOpenFiles,
  onOpenRuns,
}: {
  job: CronJob;
  tools: Tool[];
  projects: ProjectListing[];
  onEdit: () => void;
  onApply: (envelope: unknown) => Promise<boolean>;
  onOpenFiles: () => void;
  onOpenRuns: () => void;
}) {
  const targetSummary = describeTarget(job, tools, projects);
  const stateLabel = job.enabled ? "ON" : "OFF";
  const lastRun = job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "—";
  const lastStatus = job.last_status ?? "—";
  const isStandalone = job.target.kind === "standalone";
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
        {isStandalone ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={onOpenFiles}
              style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
            >
              <Text style={styles.actionBtnText}>FILES</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onOpenRuns}
              style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
            >
              <Text style={styles.actionBtnText}>RUNS</Text>
            </Pressable>
          </>
        ) : null}
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
  if (target.kind === "standalone") {
    if (target.tool_id) {
      const tool = tools.find((t) => t.id === target.tool_id);
      return `standalone · ${tool?.name ?? target.tool_id} (own folder)`;
    }
    return "standalone · inline prompt (own folder)";
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
      }
    /**
     * Phase 23: standalone cron — owns its own workspace, no project.
     * `mode` is a UI-only discriminator that decides which sub-form
     * is visible (Tool reference vs inline prompt). Server resolves
     * exactly one of `tool_id` / `prompt`.
     */
    | {
        kind: "standalone";
        mode: "tool" | "prompt";
        tool_id?: string;
        prompt?: string;
        args?: Record<string, string>;
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

  const compact = useCompactLayout();

  const target = draft.target;
  const tool =
    target.kind === "tool" ? tools.find((t) => t.id === target.tool_id) ?? null : null;

  // A cron job is project-less by default (queue / fleet-wide). The
  // `tool` and `task` target kinds genuinely need a project to run
  // against — without an active project there's no workspace to fire
  // the run in. Rather than letting the user pick those chips and
  // silently submit a payload that fails Zod's `min(1)` server-side,
  // we hide them when the fleet is empty so the form is always
  // submittable as-is.
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== "archived"),
    [projects],
  );
  const hasProjects = activeProjects.length > 0;

  // Form-level validity. We disable submit when the draft is missing
  // required bits — same checks the server runs, just surfaced eagerly
  // so the button doesn't silently no-op against a 400.
  const draftValid = isDraftValid(draft);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.modalBackdrop, compact && compactModalBackdrop]}>
        <View style={[styles.modalCard, compact && compactModalCard]}>
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
                {hasProjects ? (
                  <Pressable
                    onPress={() =>
                      setDraft((d) => ({
                        ...d,
                        target: {
                          kind: "tool",
                          tool_id: tools[0]?.id ?? "",
                          project_slug: activeProjects[0]?.slug ?? "",
                        },
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
                ) : null}
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
                        kind: "standalone",
                        mode: tools.length > 0 ? "tool" : "prompt",
                        tool_id: tools[0]?.id,
                        prompt: tools.length > 0 ? undefined : "",
                        args: {},
                      },
                    }))
                  }
                  style={[
                    styles.typeChip,
                    draft.target.kind === "standalone" && styles.typeChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      draft.target.kind === "standalone" && styles.typeChipTextActive,
                    ]}
                  >
                    standalone
                  </Text>
                </Pressable>
                {hasProjects ? (
                  <Pressable
                    onPress={() =>
                      setDraft((d) => ({
                        ...d,
                        target: {
                          kind: "task",
                          project_slug: activeProjects[0]?.slug ?? "",
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
                ) : null}
              </View>
              {!hasProjects ? (
                <Text style={styles.helperSmall}>
                  No projects yet — only fleet-wide queue targets are available.
                  Create a project first to schedule a tool or task.
                </Text>
              ) : null}

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
              ) : draft.target.kind === "standalone" ? (
                <StandaloneTargetForm
                  target={draft.target}
                  tools={tools}
                  setTarget={(updater) =>
                    setDraft((d) =>
                      d.target.kind === "standalone"
                        ? { ...d, target: updater(d.target) }
                        : d,
                    )
                  }
                />
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
              disabled={!draftValid}
              onPress={() => void onSubmit(draft)}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
                !draftValid && styles.primaryBtnDisabled,
              ]}
            >
              <Text
                style={[
                  styles.primaryBtnText,
                  !draftValid && styles.primaryBtnTextDisabled,
                ]}
              >
                {initial ? "SAVE" : "CREATE"}
              </Text>
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

/**
 * Mirrors the server's Zod constraints for `create_cron` so the
 * Save / Create button can disable itself eagerly instead of POSTing
 * a payload that 400s. Keep this in sync with `CronTargetPayload` in
 * server/src/mutations/schema.ts.
 */
function isDraftValid(d: DraftCron): boolean {
  if (!d.name.trim()) return false;
  if (!d.schedule.trim()) return false;
  const t = d.target;
  if (t.kind === "tool") {
    return !!t.tool_id && !!t.project_slug;
  }
  if (t.kind === "task") {
    return !!t.project_slug && !!t.title.trim();
  }
  if (t.kind === "standalone") {
    if (t.mode === "tool") return !!t.tool_id;
    return !!(t.prompt && t.prompt.trim().length > 0);
  }
  // queue — project_slug is optional (fleet-wide is fine).
  return true;
}

function cronToDraft(j: CronJob): DraftCron {
  // Standalone target on the wire has either tool_id or prompt; the
  // editor's `mode` discriminator is UI-only and gets recovered from
  // whichever field is present. Other target kinds round-trip as-is.
  if (j.target.kind === "standalone") {
    const usingTool = !!j.target.tool_id;
    return {
      name: j.name,
      description: j.description ?? "",
      schedule: j.schedule,
      enabled: j.enabled,
      target: {
        kind: "standalone",
        mode: usingTool ? "tool" : "prompt",
        tool_id: j.target.tool_id,
        prompt: j.target.prompt,
        args: j.target.args,
      },
    };
  }
  return {
    name: j.name,
    description: j.description ?? "",
    schedule: j.schedule,
    enabled: j.enabled,
    target: j.target,
  };
}

/**
 * Strip the editor-only `mode` field before submitting, and drop
 * whichever of {tool_id, prompt} doesn't apply for the chosen mode.
 * The server's Zod schema rejects payloads where both are set.
 */
function draftToWire(d: DraftCron): unknown {
  if (d.target.kind !== "standalone") {
    return { name: d.name, description: d.description, schedule: d.schedule, enabled: d.enabled, target: d.target };
  }
  const t = d.target;
  const target =
    t.mode === "tool"
      ? { kind: "standalone" as const, tool_id: t.tool_id, args: t.args }
      : { kind: "standalone" as const, prompt: t.prompt };
  return { name: d.name, description: d.description, schedule: d.schedule, enabled: d.enabled, target };
}

// ---- Standalone target form (Phase 23) ----

/**
 * Form section for the standalone cron target. Splits into two modes
 * — "use a Tool" or "inline prompt" — chosen by a chip toggle. Mode
 * is UI-only; on submit `draftToWire` collapses to the right server
 * shape.
 */
function StandaloneTargetForm({
  target,
  tools,
  setTarget,
}: {
  target: Extract<DraftCron["target"], { kind: "standalone" }>;
  tools: Tool[];
  setTarget: (
    updater: (
      t: Extract<DraftCron["target"], { kind: "standalone" }>,
    ) => Extract<DraftCron["target"], { kind: "standalone" }>,
  ) => void;
}) {
  const tool =
    target.mode === "tool" && target.tool_id
      ? tools.find((t) => t.id === target.tool_id) ?? null
      : null;

  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.helperSmall}>
        Standalone cron — runs in its own folder under
        {" "}<Text style={{ fontFamily: fonts.mono }}>_cron/&lt;slug&gt;/</Text>.
        No project required. Use FILES on the row to browse what the
        agent has produced.
      </Text>

      <Text style={styles.fieldLabel}>PROMPT SOURCE</Text>
      <View style={styles.typeRow}>
        <Pressable
          onPress={() =>
            setTarget((t) => ({
              ...t,
              mode: "tool",
              prompt: undefined,
              tool_id: t.tool_id ?? tools[0]?.id,
            }))
          }
          style={[styles.typeChip, target.mode === "tool" && styles.typeChipActive]}
          disabled={tools.length === 0}
        >
          <Text
            style={[
              styles.typeChipText,
              target.mode === "tool" && styles.typeChipTextActive,
              tools.length === 0 && { opacity: 0.4 },
            ]}
          >
            use a Tool
          </Text>
        </Pressable>
        <Pressable
          onPress={() =>
            setTarget((t) => ({
              ...t,
              mode: "prompt",
              tool_id: undefined,
              args: undefined,
              prompt: t.prompt ?? "",
            }))
          }
          style={[styles.typeChip, target.mode === "prompt" && styles.typeChipActive]}
        >
          <Text
            style={[
              styles.typeChipText,
              target.mode === "prompt" && styles.typeChipTextActive,
            ]}
          >
            inline prompt
          </Text>
        </Pressable>
      </View>
      {tools.length === 0 && target.mode === "tool" ? (
        <Text style={styles.helperSmall}>
          No tools yet — define one on the Tools tab to reuse a prompt
          across multiple cron jobs, or switch to inline prompt.
        </Text>
      ) : null}

      {target.mode === "tool" ? (
        <>
          <Text style={styles.fieldLabel}>TOOL</Text>
          <View style={styles.typeRow}>
            {tools.map((t) => (
              <Pressable
                key={t.id}
                onPress={() =>
                  setTarget((s) => ({ ...s, tool_id: t.id, args: {} }))
                }
                style={[
                  styles.typeChip,
                  target.tool_id === t.id && styles.typeChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    target.tool_id === t.id && styles.typeChipTextActive,
                  ]}
                >
                  {t.name}
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
                  value={target.args?.[p.name] ?? ""}
                  onChange={(v) =>
                    setTarget((s) => ({
                      ...s,
                      args: { ...(s.args ?? {}), [p.name]: v },
                    }))
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
        <Field
          label="INLINE PROMPT"
          value={target.prompt ?? ""}
          onChange={(v) => setTarget((s) => ({ ...s, prompt: v }))}
          multiline
          minHeight={140}
          hint="Sent directly to cursor-agent on every tick. The agent's cwd is the cron's owned workspace."
        />
      )}
    </View>
  );
}

// ---- Standalone-cron files modal (Phase 23) ----

/**
 * Read-only file browser scoped to a single standalone cron job's
 * workspace. Mirrors the project Code tab's structure (a thin
 * directory tree on the left, a file viewer on the right) but stays
 * inline as a modal because the cron tab is a list-of-jobs and we
 * don't want to navigate the user away from it.
 */
function CronFilesModal({
  cron,
  onClose,
}: {
  cron: CronJob | null;
  onClose: () => void;
}) {
  const visible = !!cron && cron.target.kind === "standalone";
  const [path, setPath] = useState<string>("");
  const [listing, setListing] = useState<CodeListing | null>(null);
  const [file, setFile] = useState<CodeFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compact = useCompactLayout();

  useEffect(() => {
    if (!visible || !cron) {
      setListing(null);
      setFile(null);
      setPath("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const out = await listCronFiles(cron.id, "");
        if (cancelled) return;
        setListing(out);
        setFile(null);
        setPath("");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, cron]);

  const openEntry = async (entry: CodeFileEntry) => {
    if (!cron) return;
    setLoading(true);
    setError(null);
    try {
      if (entry.kind === "dir") {
        const out = await listCronFiles(cron.id, entry.rel_path);
        setListing(out);
        setFile(null);
        setPath(entry.rel_path);
      } else {
        const out = await readCronFile(cron.id, entry.rel_path);
        setFile(out);
        setPath(entry.rel_path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const openParent = async () => {
    if (!cron || !path) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    setLoading(true);
    setError(null);
    try {
      const out = await listCronFiles(cron.id, parent);
      setListing(out);
      setFile(null);
      setPath(parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, compact && compactModalBackdrop]}>
        <View style={[styles.modalCard, styles.modalCardWide, compact && compactModalCard]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              FILES: {cron?.name?.toUpperCase() ?? ""}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          <View style={styles.modalSubHeader}>
            <Text style={styles.modalSubText}>
              {cron?.slug ? `_cron/${cron.slug}/${path}` : ""}
            </Text>
            {path ? (
              <Pressable onPress={openParent}>
                <Text style={styles.linkText}>↑ up one</Text>
              </Pressable>
            ) : null}
          </View>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorBoxText}>{error}</Text>
            </View>
          ) : null}
          <ScrollView contentContainerStyle={styles.modalBody}>
            {loading ? (
              <ActivityIndicator color={palette.cyan} />
            ) : file ? (
              <View>
                <View style={styles.fileMetaRow}>
                  <Text style={styles.fileMetaText}>
                    {file.size.toLocaleString()} bytes
                    {file.truncated ? " · truncated" : ""}
                    {file.binary ? " · binary" : ""}
                    {file.language ? ` · ${file.language}` : ""}
                  </Text>
                </View>
                {file.binary ? (
                  <Text style={styles.helperSmall}>
                    Binary file — preview unavailable.
                  </Text>
                ) : (
                  <Text style={styles.fileBody}>{file.text ?? ""}</Text>
                )}
              </View>
            ) : listing ? (
              listing.entries.length === 0 ? (
                <Text style={styles.helperSmall}>
                  Empty — the cron hasn't written anything here yet.
                  Run it once with RUN NOW to populate the workspace.
                </Text>
              ) : (
                <View style={{ gap: 4 }}>
                  {listing.entries.map((entry) => (
                    <Pressable
                      key={entry.rel_path}
                      onPress={() => void openEntry(entry)}
                      style={({ pressed }) => [
                        styles.fileEntry,
                        pressed && styles.fileEntryPressed,
                      ]}
                    >
                      <Text style={styles.fileEntryIcon}>
                        {entry.kind === "dir" ? "▸" : "·"}
                      </Text>
                      <Text style={styles.fileEntryName}>{entry.name}</Text>
                      {entry.kind === "file" && typeof entry.size === "number" ? (
                        <Text style={styles.fileEntryMeta}>
                          {entry.size.toLocaleString()}b
                        </Text>
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              )
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ---- Standalone-cron runs modal (Phase 23) ----

/**
 * Run-history viewer. Top section: list of recent ticks (most recent
 * first) with status / duration / error tail. Click a row to expand
 * its transcript inline.
 */
function CronRunsModal({
  cron,
  onClose,
}: {
  cron: CronJob | null;
  onClose: () => void;
}) {
  const visible = !!cron && cron.target.kind === "standalone";
  const [runs, setRuns] = useState<CronRun[] | null>(null);
  const [selected, setSelected] = useState<CronRun | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compact = useCompactLayout();

  useEffect(() => {
    if (!visible || !cron) {
      setRuns(null);
      setSelected(null);
      setTranscript("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await listCronRuns(cron.id);
        if (cancelled) return;
        setRuns(list);
        setSelected(null);
        setTranscript("");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, cron]);

  const select = async (run: CronRun) => {
    if (!cron) return;
    setSelected(run);
    setLoading(true);
    setError(null);
    try {
      const text = await readCronTranscript(cron.id, run.run_id);
      setTranscript(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTranscript("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, compact && compactModalBackdrop]}>
        <View style={[styles.modalCard, styles.modalCardWide, compact && compactModalCard]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              RUNS: {cron?.name?.toUpperCase() ?? ""}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorBoxText}>{error}</Text>
            </View>
          ) : null}
          <ScrollView contentContainerStyle={styles.modalBody}>
            {!runs ? (
              <ActivityIndicator color={palette.cyan} />
            ) : runs.length === 0 ? (
              <Text style={styles.helperSmall}>
                No runs yet. RUN NOW to fire one immediately, or wait
                for the schedule.
              </Text>
            ) : (
              <View style={{ gap: 4 }}>
                {runs.map((r) => {
                  const active = selected?.run_id === r.run_id;
                  return (
                    <Pressable
                      key={r.run_id}
                      onPress={() => void select(r)}
                      style={({ pressed }) => [
                        styles.runRow,
                        active && styles.runRowActive,
                        pressed && !active && styles.runRowPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.runRowStatus,
                          r.status === "ok" && { color: palette.green },
                          r.status === "error" && { color: palette.danger },
                        ]}
                      >
                        {r.status.toUpperCase()}
                      </Text>
                      <Text style={styles.runRowMeta}>
                        {new Date(r.started_at).toLocaleString()} · {r.duration_ms}ms
                      </Text>
                      {r.error ? (
                        <Text style={styles.runRowError} numberOfLines={2}>
                          {r.error}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
            {selected ? (
              <View style={styles.transcriptBox}>
                <Text style={styles.fieldLabel}>TRANSCRIPT — {selected.run_id}</Text>
                {loading ? (
                  <ActivityIndicator color={palette.cyan} />
                ) : (
                  <Text style={styles.transcriptText}>
                    {transcript || "(empty)"}
                  </Text>
                )}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
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
  primaryBtnDisabled: {
    opacity: 0.4,
    backgroundColor: "transparent",
  },
  primaryBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  primaryBtnTextDisabled: { color: palette.textMuted },

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
  /** Wider variant for the file browser + run history (Phase 23). */
  modalCardWide: { maxWidth: 960 },
  modalSubHeader: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  modalSubText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  linkText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  errorBox: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    padding: space.sm,
    borderWidth: 1,
    borderColor: palette.danger,
    borderRadius: radii.sm,
    backgroundColor: "rgba(255,80,80,0.05)",
  },
  errorBoxText: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  fileEntry: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderRadius: radii.sm,
  },
  fileEntryPressed: { backgroundColor: "rgba(0,0,0,0.18)" },
  fileEntryIcon: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    width: 14,
  },
  fileEntryName: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    flex: 1,
  },
  fileEntryMeta: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  fileMetaRow: {
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSoft,
    marginBottom: space.sm,
  },
  fileMetaText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  fileBody: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  runRow: {
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    gap: 2,
  },
  runRowActive: { borderColor: palette.cyan, backgroundColor: "rgba(0,0,0,0.16)" },
  runRowPressed: { backgroundColor: "rgba(0,0,0,0.12)" },
  runRowStatus: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    color: palette.textPrimary,
  },
  runRowMeta: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  runRowError: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  transcriptBox: {
    marginTop: space.md,
    padding: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.22)",
    gap: 6,
  },
  transcriptText: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 14,
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
