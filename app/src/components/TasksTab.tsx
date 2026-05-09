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
import type { Feature, Task, TaskStatus } from "../types";
import { useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 3 tasks view. Reading is unrestricted; adding has a soft gate:
 * feature-attached tasks require the feature to be `planned`+ (which the
 * Phase 4 council unlocks), so the modal doesn't even let you pick a
 * feature_id from this UI yet — only ad-hoc tasks (no feature) are
 * available. Chat is the escape hatch if you want to fight the gate.
 *
 * Tasks are grouped by status; we collapse `done` and `stale` by default
 * to keep the working surface focused.
 */

interface Props {
  slug: string;
  features: Feature[];
  tasks: Task[];
  onAddAdHocTask: (input: { title: string; description?: string; priority?: number }) => Promise<boolean>;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onArchiveTask: (taskId: string) => Promise<void>;
  onApproveTasks: (featureId: string, taskIds: string[]) => Promise<void>;
  /** Run a single task right now (synchronous start_task mutation). */
  onRunTask?: (taskId: string) => Promise<void>;
  /**
   * Phase 15 — transient "ping" highlight, set by the voice-driven
   * navigation handler. Auto-cleared in the store after a few
   * seconds; we just render a glow on the matching row.
   */
  highlightedTaskId?: string | null;
}

const STATUS_COLUMNS: TaskStatus[] = ["todo", "in_progress", "done", "stale"];

export function TasksTab({ features, tasks, onAddAdHocTask, onUpdateTaskStatus, onArchiveTask, onApproveTasks, onRunTask, highlightedTaskId }: Props) {
  const [adding, setAdding] = useState(false);
  const [excludedProposals, setExcludedProposals] = useState<Set<string>>(new Set());

  const featureById = useMemo(() => {
    const map = new Map<string, Feature>();
    for (const f of features) map.set(f.id, f);
    return map;
  }, [features]);

  // Bucket tasks: proposals separately from real tasks. Proposals are
  // visible only while their parent feature is in `planning`.
  const { proposalsByFeature, realTasks } = useMemo(() => {
    const proposalsByFeature = new Map<string, Task[]>();
    const realTasks: Task[] = [];
    for (const t of tasks) {
      if (t.proposed && t.feature_id) {
        const feat = featureById.get(t.feature_id);
        if (feat?.status === "planning") {
          const arr = proposalsByFeature.get(t.feature_id) ?? [];
          arr.push(t);
          proposalsByFeature.set(t.feature_id, arr);
          continue;
        }
      }
      // Hide proposed tasks once their feature has moved past planning;
      // un-approved ones get dropped on approve_tasks anyway.
      if (t.proposed) continue;
      realTasks.push(t);
    }
    for (const [, list] of proposalsByFeature) {
      list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.created_at - a.created_at);
    }
    return { proposalsByFeature, realTasks };
  }, [tasks, featureById]);

  const grouped = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [], stale: [] };
    for (const t of realTasks) out[t.status].push(t);
    for (const k of STATUS_COLUMNS) {
      out[k].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.created_at - a.created_at);
    }
    return out;
  }, [realTasks]);

  const total = realTasks.length;
  const proposalCount = Array.from(proposalsByFeature.values()).reduce((acc, l) => acc + l.length, 0);

  const toggleExclude = (taskId: string) => {
    setExcludedProposals((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.kicker}>
          // TASKS · {total}
          {proposalCount > 0 ? `  ·  ${proposalCount} PROPOSED` : ""}
        </Text>
        <Pressable
          onPress={() => setAdding(true)}
          style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
        >
          <Text style={styles.addBtnText}>+ AD-HOC TASK</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {Array.from(proposalsByFeature.entries()).map(([featId, proposals]) => {
          const feat = featureById.get(featId);
          if (!feat) return null;
          const kept = proposals.filter((p) => !excludedProposals.has(p.id));
          return (
            <ProposedSection
              key={featId}
              feature={feat}
              proposals={proposals}
              excluded={excludedProposals}
              onToggleExclude={toggleExclude}
              onApprove={() => {
                void onApproveTasks(featId, kept.map((t) => t.id));
                setExcludedProposals(new Set());
              }}
            />
          );
        })}

        {total === 0 && proposalCount === 0 ? (
          <Empty />
        ) : (
          STATUS_COLUMNS.map((s) =>
            grouped[s].length === 0 ? null : (
              <Section key={s} status={s} count={grouped[s].length}>
                {grouped[s].map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    feature={t.feature_id ? featureById.get(t.feature_id) : undefined}
                    onChangeStatus={(next) => void onUpdateTaskStatus(t.id, next)}
                    onArchive={() => void onArchiveTask(t.id)}
                    onRun={onRunTask ? () => void onRunTask(t.id) : undefined}
                    highlighted={t.id === highlightedTaskId}
                  />
                ))}
              </Section>
            ),
          )
        )}
      </ScrollView>

      <NewAdHocTaskModal
        visible={adding}
        onCancel={() => setAdding(false)}
        onSubmit={async (input) => {
          const ok = await onAddAdHocTask(input);
          if (ok) setAdding(false);
          return ok;
        }}
      />
    </View>
  );
}

function ProposedSection({
  feature,
  proposals,
  excluded,
  onToggleExclude,
  onApprove,
}: {
  feature: Feature;
  proposals: Task[];
  excluded: Set<string>;
  onToggleExclude: (id: string) => void;
  onApprove: () => void;
}) {
  const keepCount = proposals.filter((p) => !excluded.has(p.id)).length;
  return (
    <View style={styles.proposedRoot}>
      <View style={styles.proposedHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.proposedKicker}>// PROPOSED · {feature.name.toUpperCase()}</Text>
          <Text style={styles.proposedHint}>
            Council planned {proposals.length} task{proposals.length === 1 ? "" : "s"} for this feature.
            Tap a task to drop it from the plan, then approve to flip the rest into real tasks.
          </Text>
        </View>
        <Pressable
          onPress={keepCount > 0 ? onApprove : undefined}
          disabled={keepCount === 0}
          style={({ pressed }) => [
            styles.approveBtn,
            keepCount === 0 && { opacity: 0.4 },
            pressed && keepCount > 0 && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.approveBtnText}>APPROVE {keepCount}</Text>
        </Pressable>
      </View>
      <View style={styles.proposedList}>
        {proposals.map((p) => {
          const isExcluded = excluded.has(p.id);
          return (
            <Pressable
              key={p.id}
              onPress={() => onToggleExclude(p.id)}
              style={({ pressed }) => [
                styles.proposalRow,
                isExcluded && styles.proposalRowExcluded,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.proposalTitle, isExcluded && styles.proposalTextExcluded]}>
                {isExcluded ? "× " : "✓ "}
                {p.title}
              </Text>
              {p.description ? (
                <Text style={[styles.proposalDesc, isExcluded && styles.proposalTextExcluded]} numberOfLines={2}>
                  {p.description}
                </Text>
              ) : null}
              {p.priority !== undefined ? (
                <Text style={[styles.proposalMeta, isExcluded && styles.proposalTextExcluded]}>
                  priority {p.priority}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Section({
  status,
  count,
  children,
}: {
  status: TaskStatus;
  count: number;
  children: React.ReactNode;
}) {
  const tone = toneFor(status);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={[styles.sectionDot, { backgroundColor: tone.fg }]} />
        <Text style={[styles.sectionLabel, { color: tone.fg }]}>
          {status.replace("_", " ").toUpperCase()}
        </Text>
        <Text style={styles.sectionCount}>· {count}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function TaskRow({
  task,
  feature,
  onChangeStatus,
  onArchive,
  onRun,
  highlighted,
}: {
  task: Task;
  feature?: Feature;
  onChangeStatus: (s: TaskStatus) => void;
  onArchive: () => void;
  onRun?: () => void;
  highlighted?: boolean;
}) {
  const next = nextStatus(task.status);
  // Eligibility for the queue worker: feature-attached tasks need the
  // feature in `planned` or `in_progress`; ad-hoc tasks always run.
  const featureGateOk = !task.feature_id || feature?.status === "planned" || feature?.status === "in_progress";
  const canRun = task.status === "todo" && !task.proposed && featureGateOk;
  return (
    <View
      style={[
        styles.row,
        // Phase 15 — voice-nav landed here. Soft cyan border + glow
        // for ~5s (auto-cleared in the store) so the user's eye
        // catches the right card without us hijacking selection
        // state. Auto-fades back to default when the timer fires.
        highlighted && {
          borderColor: palette.cyan,
          backgroundColor: "rgba(92, 246, 255, 0.06)",
          ...glow(palette.cyanGlow, 14),
        },
      ]}
    >
      <View style={[styles.rowEdge, { backgroundColor: toneFor(task.status).fg }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {task.title}
          </Text>
          {task.priority !== undefined && task.priority !== 0 ? (
            <Text style={styles.rowPriority}>p{task.priority}</Text>
          ) : null}
        </View>
        {task.description ? (
          <Text style={styles.rowDesc} numberOfLines={2}>
            {task.description}
          </Text>
        ) : null}
        <View style={styles.rowFoot}>
          <Text style={styles.rowMeta}>
            {feature ? `↳ ${feature.name}` : "ad-hoc"} · {task.id}
          </Text>
          <View style={styles.rowActions}>
            {onRun && canRun ? (
              <Pressable
                onPress={onRun}
                style={({ pressed }) => [styles.runBtn, pressed && glow(palette.cyan, 12)]}
              >
                <Text style={styles.runBtnText}>▶ RUN</Text>
              </Pressable>
            ) : null}
            {next ? (
              <Pressable
                onPress={() => onChangeStatus(next)}
                style={({ pressed }) => [styles.rowAction, pressed && styles.rowActionPressed]}
              >
                <Text style={styles.rowActionText}>→ {next.replace("_", " ").toUpperCase()}</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onArchive}
              style={({ pressed }) => [styles.archiveBtn, pressed && styles.archiveBtnPressed]}
            >
              <Text style={styles.archiveBtnText}>ARCHIVE</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function nextStatus(s: TaskStatus): TaskStatus | null {
  if (s === "todo") return "in_progress";
  if (s === "in_progress") return "done";
  if (s === "stale") return "todo";
  return null;
}

function toneFor(s: TaskStatus): { fg: string } {
  switch (s) {
    case "todo": return { fg: palette.cyan };
    case "in_progress": return { fg: palette.amber };
    case "done": return { fg: palette.green };
    case "stale": return { fg: palette.textMuted };
  }
}

function Empty() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyKicker}>// EMPTY</Text>
      <Text style={styles.emptyTitle}>No tasks yet</Text>
      <Text style={styles.emptySub}>
        Add an ad-hoc task here, or wait for the council (Phase 4) to plan
        feature-attached tasks once their flows are approved. The agent can
        also add ad-hoc tasks directly from chat.
      </Text>
    </View>
  );
}

function NewAdHocTaskModal({
  visible,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; description?: string; priority?: number }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = title.trim().length > 0 && !busy;

  const compact = useCompactLayout();

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const p = priority.trim() === "" ? undefined : Number(priority);
    const ok = await onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      priority: p !== undefined && Number.isFinite(p) ? Math.trunc(p) : undefined,
    });
    setBusy(false);
    if (ok) {
      setTitle("");
      setDescription("");
      setPriority("");
    }
  };

  const close = () => {
    onCancel();
    setTitle("");
    setDescription("");
    setPriority("");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={[modalStyles.overlay, compact && compactModalBackdrop]}>
        <View style={[modalStyles.panel, compact && compactModalCard]}>
          <Text style={modalStyles.kicker}>// AD-HOC TASK</Text>
          <Text style={modalStyles.title}>Add a task</Text>
          <Text style={modalStyles.subtitle}>
            Phase 3 only allows ad-hoc tasks (no feature_id). Feature-attached
            tasks unlock once the council approves the flow.
          </Text>

          <Text style={modalStyles.label}>TITLE</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Investigate login bug"
            placeholderTextColor={palette.textMuted}
            style={modalStyles.input}
            autoFocus
          />

          <Text style={modalStyles.label}>DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's the desired outcome?"
            placeholderTextColor={palette.textMuted}
            multiline
            numberOfLines={3}
            style={[modalStyles.input, modalStyles.inputMulti]}
          />

          <Text style={modalStyles.label}>PRIORITY (OPTIONAL, INTEGER — HIGHER = SOONER)</Text>
          <TextInput
            value={priority}
            onChangeText={setPriority}
            placeholder="0"
            placeholderTextColor={palette.textMuted}
            keyboardType="number-pad"
            style={modalStyles.input}
          />

          <View style={modalStyles.actions}>
            <Pressable onPress={close} style={modalStyles.cancelBtn}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={!ready}
              style={[modalStyles.submitBtn, !ready && modalStyles.submitBtnDisabled]}
            >
              <Text style={modalStyles.submitText}>{busy ? "Adding…" : "Add Task"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  proposedRoot: {
    margin: space.md,
    marginBottom: space.lg,
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(183,139,255,0.4)",
    backgroundColor: "rgba(183,139,255,0.06)",
    gap: space.sm,
  },
  proposedHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  proposedKicker: { color: palette.violet, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6, fontWeight: "700" },
  proposedHint: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, lineHeight: 17, marginTop: 4 },
  approveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(118,245,176,0.5)",
    backgroundColor: "rgba(118,245,176,0.1)",
  },
  approveBtnText: { color: palette.green, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
  proposedList: { gap: 6 },
  proposalRow: {
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(15,22,38,0.5)",
  },
  proposalRowExcluded: { opacity: 0.5, borderStyle: "dashed" },
  proposalTitle: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 13, fontWeight: "600" },
  proposalDesc: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, marginTop: 2, lineHeight: 16 },
  proposalMeta: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10, marginTop: 4, letterSpacing: 0.6 },
  proposalTextExcluded: { textDecorationLine: "line-through" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  kicker: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(255,180,84,0.45)",
    backgroundColor: "rgba(255,180,84,0.06)",
  },
  addBtnPressed: { backgroundColor: "rgba(255,180,84,0.12)" },
  addBtnText: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  list: { padding: space.lg, gap: space.lg },

  section: { gap: space.sm },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionDot: { width: 8, height: 8, borderRadius: 4 },
  sectionLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6, fontWeight: "700" },
  sectionCount: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10 },
  sectionBody: { gap: space.sm },

  row: {
    flexDirection: "row",
    backgroundColor: "rgba(15,22,38,0.6)",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    overflow: "hidden",
  },
  rowEdge: { width: 2, alignSelf: "stretch" },
  rowBody: { flex: 1, padding: space.md, gap: 4, minWidth: 0 },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  rowTitle: { flex: 1, color: palette.textPrimary, fontSize: 14, fontFamily: fonts.body, fontWeight: "500" },
  rowPriority: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11, fontWeight: "600" },
  rowDesc: { color: palette.textSecondary, fontSize: 12, lineHeight: 16, fontFamily: fonts.body },
  rowFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  rowMeta: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6 },
  rowActions: { flexDirection: "row", gap: 6 },
  rowAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  rowActionPressed: { backgroundColor: "rgba(92,246,255,0.06)", borderColor: palette.cyanDim },
  rowActionText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2, fontWeight: "600" },
  runBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  runBtnText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4, fontWeight: "700" },
  archiveBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  archiveBtnPressed: { backgroundColor: "rgba(255,107,107,0.08)", borderColor: "rgba(255,107,107,0.4)" },
  archiveBtnText: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2 },

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: 6 },
  emptyKicker: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  emptyTitle: { color: palette.textPrimary, fontSize: 20, fontWeight: "600", fontFamily: fonts.body },
  emptySub: {
    color: palette.textSecondary,
    textAlign: "center",
    maxWidth: 480,
    fontSize: 13,
    fontFamily: fonts.body,
    lineHeight: 20,
    marginTop: 4,
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(5,7,13,0.88)",
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  panel: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderHair,
    padding: space.xl,
    gap: space.sm,
    ...glow(palette.cyanGlow, 18),
  },
  kicker: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  title: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 18, fontWeight: "600" },
  subtitle: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 4,
  },
  label: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.6,
    marginTop: space.sm,
  },
  input: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    backgroundColor: palette.bgBase,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  inputMulti: { minHeight: 70, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.md },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  cancelText: { color: palette.textSecondary, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.2 },
  submitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.amber,
    backgroundColor: "rgba(255,180,84,0.1)",
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
});
