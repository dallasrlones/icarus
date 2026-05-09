import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Feature, FeatureStatus, Task } from "../types";
import { useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 3 features view. Lists active features with their lifecycle pill,
 * plus a `+ NEW FEATURE` button that opens an inline modal. The modal
 * sends an `add_feature` mutation via the store helper, which refreshes
 * the list when the server confirms.
 *
 * Phase 3 only allows draft / flowing reachable from the UI; the other
 * statuses (flow_review / flow_approved / planning / planned / …) are
 * driven by the council in Phase 4 — we still render them correctly here
 * so the UI doesn't lie when the data shows up.
 */

interface Props {
  slug: string;
  features: Feature[];
  /** Tasks for the project — used to detect "has stale tasks" → show Replan. */
  tasks: Task[];
  selectedFeatureId: string | null;
  onSelectFeature: (id: string) => void;
  onArchiveFeature: (id: string) => void;
  onAddFeature: (input: { name: string; description?: string }) => Promise<boolean>;
  onReplan: (featureId: string) => void;
}

export function FeaturesTab({
  features,
  tasks,
  selectedFeatureId,
  onSelectFeature,
  onArchiveFeature,
  onAddFeature,
  onReplan,
}: Props) {
  const [adding, setAdding] = useState(false);
  const visible = features.filter((f) => f.status !== "archived");

  const staleByFeature = new Map<string, number>();
  /**
   * Progress tally per feature: { done, total } counted only over real
   * (non-proposed) tasks. Stale tasks are included in `total` so the bar
   * reflects "completion vs original plan", not "completion vs current
   * runnable set" — the stale strip already disambiguates.
   */
  const progressByFeature = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (!t.feature_id) continue;
    if (t.proposed) continue;
    const p = progressByFeature.get(t.feature_id) ?? { done: 0, total: 0 };
    p.total += 1;
    if (t.status === "done") p.done += 1;
    progressByFeature.set(t.feature_id, p);
    if (t.status === "stale") {
      staleByFeature.set(t.feature_id, (staleByFeature.get(t.feature_id) ?? 0) + 1);
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.kicker}>// FEATURES · {visible.length}</Text>
        <Pressable
          onPress={() => setAdding(true)}
          style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
        >
          <Text style={styles.addBtnText}>+ NEW FEATURE</Text>
        </Pressable>
      </View>

      {visible.length === 0 ? (
        <Empty />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {visible.map((f) => (
            <FeatureRow
              key={f.id}
              feature={f}
              selected={f.id === selectedFeatureId}
              staleCount={staleByFeature.get(f.id) ?? 0}
              progress={progressByFeature.get(f.id) ?? { done: 0, total: 0 }}
              onSelect={() => onSelectFeature(f.id)}
              onArchive={() => onArchiveFeature(f.id)}
              onReplan={() => onReplan(f.id)}
            />
          ))}
        </ScrollView>
      )}

      <NewFeatureModal
        visible={adding}
        onCancel={() => setAdding(false)}
        onSubmit={async (input) => {
          const ok = await onAddFeature(input);
          if (ok) setAdding(false);
          return ok;
        }}
      />
    </View>
  );
}

function FeatureRow({
  feature,
  selected,
  staleCount,
  progress,
  onSelect,
  onArchive,
  onReplan,
}: {
  feature: Feature;
  selected: boolean;
  staleCount: number;
  progress: { done: number; total: number };
  onSelect: () => void;
  onArchive: () => void;
  onReplan: () => void;
}) {
  const canReplan = staleCount > 0 && feature.status === "flowing";
  const pct =
    progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const showProgress = progress.total > 0;
  return (
    <Pressable
      onPress={onSelect}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.rowEdge, selected && styles.rowEdgeSelected]} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowName} numberOfLines={1}>
            {feature.name}
          </Text>
          <StatusPill status={feature.status} />
        </View>
        {feature.description ? (
          <Text style={styles.rowDesc} numberOfLines={2}>
            {feature.description}
          </Text>
        ) : (
          <Text style={[styles.rowDesc, styles.rowDescEmpty]}>
            no description — click to open the flow canvas and start drafting
          </Text>
        )}
        {showProgress ? (
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${pct}%` }]} />
            </View>
            <Text style={styles.progressLabel}>
              {progress.done}/{progress.total} · {pct}%
            </Text>
          </View>
        ) : null}
        {staleCount > 0 ? (
          <View style={styles.staleStrip}>
            <Text style={styles.staleStripText}>
              {staleCount} stale task{staleCount === 1 ? "" : "s"} — flow edited after approval
            </Text>
          </View>
        ) : null}
        <View style={styles.rowFoot}>
          <Text style={styles.rowMeta}>{feature.id}</Text>
          <View style={styles.rowFootBtns}>
            {canReplan ? (
              <Pressable
                hitSlop={8}
                onPress={(e) => {
                  e.stopPropagation?.();
                  onReplan();
                }}
                style={({ pressed }) => [styles.replanBtn, pressed && styles.replanBtnPressed]}
              >
                <Text style={styles.replanBtnText}>REPLAN</Text>
              </Pressable>
            ) : null}
            <Pressable
              hitSlop={8}
              onPress={(e) => {
                e.stopPropagation?.();
                onArchive();
              }}
              style={({ pressed }) => [styles.archiveBtn, pressed && styles.archiveBtnPressed]}
            >
              <Text style={styles.archiveBtnText}>ARCHIVE</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function StatusPill({ status }: { status: FeatureStatus }) {
  const t = toneFor(status);
  return (
    <View style={[styles.statusPill, { borderColor: t.border, backgroundColor: t.bg }]}>
      <Text style={[styles.statusPillText, { color: t.fg }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

function toneFor(status: FeatureStatus): { fg: string; bg: string; border: string } {
  switch (status) {
    case "draft":
      return { fg: palette.textSecondary, bg: "rgba(80,96,116,0.18)", border: palette.borderHair };
    case "flowing":
      return { fg: palette.cyan, bg: "rgba(92,246,255,0.06)", border: "rgba(92,246,255,0.32)" };
    case "flow_review":
    case "planning":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.07)", border: "rgba(255,180,84,0.32)" };
    case "flow_approved":
    case "planned":
      return { fg: palette.violet, bg: "rgba(183,139,255,0.08)", border: "rgba(183,139,255,0.34)" };
    case "in_progress":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.08)", border: "rgba(255,180,84,0.4)" };
    case "done":
      return { fg: palette.green, bg: "rgba(118,245,176,0.08)", border: "rgba(118,245,176,0.34)" };
    case "archived":
    default:
      return { fg: palette.textMuted, bg: "rgba(80,96,116,0.12)", border: palette.borderSoft };
  }
}

function Empty() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyKicker}>// EMPTY</Text>
      <Text style={styles.emptyTitle}>No features yet</Text>
      <Text style={styles.emptySub}>
        Features capture what you're building. Add one here or just ask the
        per-project chat ("draft a feature for password reset") — the agent
        will emit the corresponding `add_feature` block.
      </Text>
    </View>
  );
}

function NewFeatureModal({
  visible,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (input: { name: string; description?: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = name.trim().length > 0 && !busy;

  const compact = useCompactLayout();

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
    });
    setBusy(false);
    if (ok) {
      setName("");
      setDescription("");
    }
  };

  const close = () => {
    onCancel();
    setName("");
    setDescription("");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={[modalStyles.overlay, compact && compactModalBackdrop]}>
        <View style={[modalStyles.panel, compact && compactModalCard]}>
          <Text style={modalStyles.kicker}>// NEW FEATURE</Text>
          <Text style={modalStyles.title}>Add a feature</Text>

          <Text style={modalStyles.label}>NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Onboarding"
            placeholderTextColor={palette.textMuted}
            style={modalStyles.input}
            autoFocus
          />

          <Text style={modalStyles.label}>DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What does this feature do?"
            placeholderTextColor={palette.textMuted}
            multiline
            numberOfLines={3}
            style={[modalStyles.input, modalStyles.inputMulti]}
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
              <Text style={modalStyles.submitText}>{busy ? "Adding…" : "Add Feature"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
  kicker: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.6,
  },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: "rgba(92,246,255,0.06)",
    ...glow(palette.cyanGlow, 8),
  },
  addBtnPressed: { backgroundColor: "rgba(92,246,255,0.12)" },
  addBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "600",
  },

  list: { padding: space.lg, gap: space.md },

  row: {
    flexDirection: "row",
    backgroundColor: "rgba(15,22,38,0.6)",
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    overflow: "hidden",
  },
  rowSelected: {
    borderColor: palette.cyanDim,
    ...glow(palette.cyanGlow, 8),
  },
  rowPressed: { backgroundColor: "rgba(92,246,255,0.04)" },
  rowEdge: { width: 2, alignSelf: "stretch", backgroundColor: palette.violetDim },
  rowEdgeSelected: { backgroundColor: palette.cyan },
  rowBody: { flex: 1, padding: space.md, gap: 6, minWidth: 0 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowName: { color: palette.textPrimary, fontSize: 15, fontWeight: "600", fontFamily: fonts.body, flex: 1 },
  rowDesc: { color: palette.textSecondary, fontSize: 12, lineHeight: 16, fontFamily: fonts.body },
  rowDescEmpty: { fontStyle: "italic", color: palette.textMuted },
  rowFoot: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  rowMeta: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6 },

  archiveBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  archiveBtnPressed: {
    backgroundColor: "rgba(255,107,107,0.08)",
    borderColor: "rgba(255,107,107,0.4)",
  },
  archiveBtnText: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2 },
  rowFootBtns: { flexDirection: "row", gap: 6 },
  replanBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "rgba(255,180,84,0.5)",
    backgroundColor: "rgba(255,180,84,0.08)",
  },
  replanBtnPressed: { backgroundColor: "rgba(255,180,84,0.18)" },
  replanBtnText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2, fontWeight: "700" },
  staleStrip: {
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    backgroundColor: "rgba(255,180,84,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,180,84,0.32)",
  },
  staleStripText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6 },

  progressWrap: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: "rgba(120,220,255,0.1)",
    overflow: "hidden",
  },
  progressFill: {
    height: 4,
    backgroundColor: palette.cyan,
    borderRadius: radii.pill,
  },
  progressLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    minWidth: 64,
    textAlign: "right",
  },

  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  statusPillText: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2, fontWeight: "600" },

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: 6 },
  emptyKicker: { color: palette.violet, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
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
  kicker: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  title: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 18, fontWeight: "600" },
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
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.1)",
    ...glow(palette.cyanGlow, 12),
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
});
