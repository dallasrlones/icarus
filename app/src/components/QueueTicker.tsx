import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useCompactLayout } from "../layout/compact";
import { fonts, glow, palette, radii, space } from "../theme";
import type { ProjectListing, QueueSnapshot, RunningTaskStatus } from "../types";

/**
 * Always-visible "ticker" strip pinned at the bottom of the app shell.
 *
 * - Shows live queue state (idle / running / paused / drained).
 * - When a task is running, shows the task title + a pulsing cyan dot +
 *   a tiny tail of the agent's output stream.
 * - Tap the strip to open a full-screen modal with the live transcript.
 * - Inline controls: Run / Pause / Resume / Stop.
 *
 * Mobile-first: collapses to a single line on narrow viewports.
 */

interface Props {
  queue: QueueSnapshot;
  runningTail: string;
  projects: ProjectListing[];
  onStart: (slug?: string) => void;
  onPause: () => void;
  onStop: () => void;
}

export function QueueTicker({ queue, runningTail, projects, onStart, onPause, onStop }: Props) {
  const [expanded, setExpanded] = useState(false);
  const compact = useCompactLayout();

  const { state, current, running } = queue;
  const runningCount = running?.length ?? (current ? 1 : 0);
  const tone = pickTone(state.run, current?.status);
  const dotColor = tone.color;
  const titleText = current
    ? current.title
    : state.run === "paused"
      ? "queue paused"
      : state.run === "running"
        ? "scanning queue…"
        : state.note ?? "queue idle";

  const statusLabel =
    state.run === "running" && current
      ? statusText(current.status)
      : state.run.toUpperCase();

  const tailPreview = (current?.output_tail || runningTail).split(/\r?\n/).slice(-1)[0] ?? "";

  const projectName = current
    ? projects.find((p) => p.slug === current.project_slug)?.name ?? current.project_slug
    : null;

  const queueActions = (
    <>
      {state.run === "running" ? (
        <ActionButton label="PAUSE" tone="amber" compact={compact} onPress={() => { onPause(); }} />
      ) : state.run === "paused" ? (
        <ActionButton label="RESUME" tone="cyan" compact={compact} onPress={() => { onStart(state.scope.project_slug); }} />
      ) : (
        <ActionButton label="▶ RUN" tone="cyan" compact={compact} onPress={() => { onStart(state.scope.project_slug); }} />
      )}
      {(state.run === "running" || state.run === "paused") && (
        <ActionButton label="STOP" tone="rose" compact={compact} onPress={() => { onStop(); }} />
      )}
    </>
  );

  return (
    <>
      <Pressable onPress={() => setExpanded(true)} style={[styles.bar, compact && styles.barCompact]}>
        <View style={[styles.barTop, compact && styles.barTopCompact]}>
          <View style={[styles.dot, { backgroundColor: dotColor }, glow(dotColor, 8) as object]} />

          <View style={styles.content}>
            <View style={styles.headerRow}>
              <Text style={styles.tag}>{statusLabel}</Text>
              {runningCount > 1 && (
                <Text style={styles.parallelTag}>×{runningCount}</Text>
              )}
              {projectName && <Text style={styles.project}>// {projectName}</Text>}
              <Text style={styles.title} numberOfLines={compact ? 2 : 1}>
                {titleText}
              </Text>
            </View>
            {!compact && tailPreview ? (
              <Text style={styles.tail} numberOfLines={1}>
                {tailPreview.slice(-160)}
              </Text>
            ) : null}
          </View>
        </View>
        {compact && tailPreview ? (
          <Text style={styles.tail} numberOfLines={2}>
            {tailPreview.slice(-160)}
          </Text>
        ) : null}

        {compact ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.actionsScroll}
          >
            {queueActions}
          </ScrollView>
        ) : (
          <View style={styles.actions}>{queueActions}</View>
        )}
      </Pressable>

      <RunningTaskModal
        visible={expanded}
        onClose={() => setExpanded(false)}
        queue={queue}
        runningTail={runningTail}
        projectName={projectName}
      />
    </>
  );
}

function ActionButton({
  label,
  tone,
  compact,
  onPress,
}: {
  label: string;
  tone: "cyan" | "amber" | "rose";
  compact?: boolean;
  onPress: () => void;
}) {
  const color = tone === "cyan" ? palette.cyan : tone === "amber" ? palette.amber : palette.rose;
  const dim = tone === "cyan" ? palette.cyanDim : tone === "amber" ? "rgba(255,180,84,0.45)" : "rgba(255,107,155,0.45)";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        compact && styles.btnCompact,
        { borderColor: dim },
        pressed && glow(color, 12),
      ]}
    >
      <Text style={[styles.btnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function RunningTaskModal({
  visible,
  onClose,
  queue,
  runningTail,
  projectName,
}: {
  visible: boolean;
  onClose: () => void;
  queue: QueueSnapshot;
  runningTail: string;
  projectName: string | null;
}) {
  const { current, state, running } = queue;
  const compact = useCompactLayout();
  const runningList = running ?? (current ? [current] : []);
  const fullTail = runningTail || current?.output_tail || "";
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, compact && styles.modalBackdropCompact]}>
        <View style={[styles.modalCard, compact && styles.modalCardCompact]}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalKicker}>// running tasks ({runningList.length})</Text>
              <Text style={styles.modalTitle} numberOfLines={2}>
                {current?.title ?? state.note ?? "Queue idle"}
              </Text>
              {projectName && <Text style={styles.modalSub}>project: {projectName}</Text>}
              {current && (
                <Text style={styles.modalSub}>
                  status: {current.status} · pills: {current.pills} · retries: {current.retries}
                </Text>
              )}
              {state.note && <Text style={styles.modalSub}>note: {state.note}</Text>}
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeText}>CLOSE</Text>
            </Pressable>
          </View>
          {runningList.length > 1 && (
            <View style={styles.runningStrip}>
              {runningList.map((rt) => (
                <View key={rt.task_id} style={styles.runningChip}>
                  <Text style={styles.runningChipTag}>{rt.project_slug}</Text>
                  <Text style={styles.runningChipTitle} numberOfLines={1}>{rt.title}</Text>
                  <Text style={styles.runningChipStatus}>{rt.status}</Text>
                </View>
              ))}
            </View>
          )}
          <ScrollView style={styles.tailScroll} contentContainerStyle={{ padding: space.md }}>
            <Text style={styles.tailFull} selectable>
              {fullTail || "(no output yet)"}
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function pickTone(run: string, status?: RunningTaskStatus): { color: string } {
  if (run === "running") {
    if (status === "awaiting_question") return { color: palette.amber };
    if (status === "failed" || status === "cancelled") return { color: palette.rose };
    if (status === "completed") return { color: palette.green };
    return { color: palette.cyan };
  }
  if (run === "paused") return { color: palette.amber };
  return { color: palette.textMuted };
}

function statusText(status: RunningTaskStatus): string {
  switch (status) {
    case "spawning": return "BOOTING";
    case "running": return "RUNNING";
    case "completed": return "DONE";
    case "failed": return "FAILED";
    case "awaiting_question": return "AWAITING";
    case "cancelled": return "CANCELLED";
  }
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  barCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  barTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    minWidth: 0,
    flex: 1,
  },
  barTopCompact: {
    flex: 0,
    alignSelf: "stretch",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
  },
  content: { flex: 1, minWidth: 0 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  tag: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  parallelTag: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    borderRadius: radii.pill,
  },
  runningStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  runningChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.sm,
    backgroundColor: palette.bgBase,
    maxWidth: 320,
  },
  runningChipTag: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  runningChipTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 12,
    flexShrink: 1,
  },
  runningChipStatus: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  project: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  title: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  tail: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  actions: { flexDirection: "row", gap: space.sm, flexShrink: 0 },
  actionsScroll: {
    flexDirection: "row",
    gap: space.sm,
    alignItems: "center",
    paddingVertical: 4,
    alignSelf: "stretch",
  },
  btn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radii.pill,
    backgroundColor: palette.bgBase,
  },
  btnCompact: {
    minHeight: 40,
    paddingVertical: 9,
  },
  btnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(5, 7, 13, 0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: space.lg,
  },
  modalBackdropCompact: {
    padding: space.sm,
    alignItems: "stretch",
  },
  modalCardCompact: {
    alignSelf: "stretch",
    width: "100%",
    maxHeight: "96%",
    borderRadius: radii.md,
  },
  modalCard: {
    width: Platform.OS === "web" ? Math.min(880, undefined as unknown as number) : "100%",
    maxWidth: 880,
    flex: Platform.OS === "web" ? 0 : 1,
    height: Platform.OS === "web" ? "85%" : "92%",
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
  },
  modalKicker: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  modalTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
  },
  modalSub: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.pill,
  },
  closeText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.2,
  },
  tailScroll: { flex: 1, backgroundColor: palette.bgDeep },
  tailFull: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
});
