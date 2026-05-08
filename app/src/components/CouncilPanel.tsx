import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  ChairReport,
  CouncilFinding,
  CouncilRun,
  Feature,
  FeatureStatus,
  FlowReviewResult,
  LensReport,
  ResolvedPersona,
  Severity,
  Verdict,
} from "../types";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Per-persona accent color, mirroring the `Persona.accent` enum.
 * Returns null for "no accent" so callers can fall back to verdict
 * coloring. Kept in this file (rather than a shared theme helper)
 * because the council panel is the only consumer today.
 */
function personaAccentColor(
  accent: ResolvedPersona["accent"] | null | undefined,
): string | null {
  switch (accent) {
    case "cyan": return palette.cyan;
    case "violet": return palette.violet;
    case "amber": return palette.amber;
    case "green": return palette.green;
    // The palette doesn't ship a `rose` token; use danger as the
    // closest match (warm pink/red). Cheap reuse, no theme churn.
    case "rose": return palette.danger;
    default: return null;
  }
}

/**
 * Council panel for a feature's flow review pipeline.
 *
 * Rendering rules by feature.status:
 *   - flowing:        show "Request flow review" + "Approve flow" (skip-council escape hatch).
 *                     If a previous run exists (e.g. user rejected), show its summary.
 *   - flow_review:    show "Approve flow" + "Request changes". If latest run is `running`, show
 *                     a progress shimmer; once `completed`, show the lens grid + chair.
 *   - flow_approved:  read-only summary of the approving run + "Plan tasks" button.
 *   - planning:       running indicator for task_planning run.
 *   - planned/in_progress/done: collapsed historical view.
 *
 * The panel is intentionally narrow (vertically scrolling lens list) so it can sit beside the
 * flow canvas without dominating it.
 */

interface Props {
  feature: Feature;
  runs: CouncilRun[];
  /**
   * Architecture gate state for this project. When the architecture is
   * empty or unapproved, the "Plan tasks" CTA is rendered as a disabled
   * "ARCH NOT APPROVED" affordance with a one-line hint pointing at the
   * Architecture tab. This mirrors the server-side gate inside
   * `applyRequestTaskPlanning`.
   */
  architectureState: "empty" | "pending" | "approved";
  /**
   * Phase 14 — the resolved lens panel for this project. Used to
   * paint each lens card with its persona's `accent` so a custom
   * "marketing" lens reads visually distinct from the default
   * "ux" lens. Optional: when missing or a lens has no accent,
   * the card falls back to the verdict-tone coloring.
   */
  resolvedPersonas?: ResolvedPersona[];
  onRequestReview: () => void;
  onApproveFlow: (runId?: string) => void;
  onRequestChanges: () => void;
  onPlanTasks: () => void;
}

export function CouncilPanel({
  feature,
  runs,
  architectureState,
  resolvedPersonas,
  onRequestReview,
  onApproveFlow,
  onRequestChanges,
  onPlanTasks,
}: Props) {
  const flowRuns = runs.filter((r) => r.type === "flow_review");
  const latest = flowRuns[0]; // server returns newest-first
  const status = feature.status;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.kicker}>// COUNCIL</Text>
        <StatusChip status={status} />
      </View>

      <Actions
        status={status}
        latestRunId={latest?.id}
        latestStatus={latest?.status ?? null}
        architectureState={architectureState}
        onRequestReview={onRequestReview}
        onApproveFlow={onApproveFlow}
        onRequestChanges={onRequestChanges}
        onPlanTasks={onPlanTasks}
      />

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {!latest ? (
          <EmptyState status={status} />
        ) : latest.status === "pending" ? (
          <RunningIndicator label="Queued — waiting for the worker" />
        ) : latest.status === "running" ? (
          <RunningIndicator label="Council is reviewing the flow…" />
        ) : latest.status === "failed" ? (
          <FailureCard error={latest.error ?? "unknown error"} startedAt={latest.started_at} />
        ) : latest.result?.kind === "flow_review" ? (
          <ReviewResult
            result={latest.result}
            startedAt={latest.started_at}
            resolvedPersonas={resolvedPersonas}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

// ---- Action bar ----

function Actions({
  status,
  latestRunId,
  latestStatus,
  architectureState,
  onRequestReview,
  onApproveFlow,
  onRequestChanges,
  onPlanTasks,
}: {
  status: FeatureStatus;
  latestRunId: string | undefined;
  latestStatus: CouncilRun["status"] | null;
  architectureState: "empty" | "pending" | "approved";
  onRequestReview: () => void;
  onApproveFlow: (runId?: string) => void;
  onRequestChanges: () => void;
  onPlanTasks: () => void;
}) {
  const reviewInFlight = latestStatus === "pending" || latestStatus === "running";
  const archGateOpen = architectureState === "approved";
  return (
    <View style={styles.actions}>
      {(status === "flowing") && (
        <ActionBtn
          tone="cyan"
          label="REQUEST FLOW REVIEW"
          onPress={onRequestReview}
        />
      )}
      {status === "flow_review" && (
        <>
          {reviewInFlight ? (
            <ActionBtn tone="muted" label="REVIEW IN FLIGHT…" disabled onPress={() => undefined} />
          ) : (
            <ActionBtn
              tone="cyan"
              label="RE-RUN REVIEW"
              onPress={onRequestReview}
            />
          )}
          <ActionBtn tone="green" label="APPROVE FLOW" onPress={() => onApproveFlow(latestRunId)} />
          <ActionBtn tone="amber" label="REQUEST CHANGES" onPress={onRequestChanges} />
        </>
      )}
      {status === "flowing" && (
        <ActionBtn
          tone="green"
          variant="ghost"
          label="APPROVE WITHOUT REVIEW"
          onPress={() => onApproveFlow()}
        />
      )}
      {status === "flow_approved" && (
        archGateOpen ? (
          <ActionBtn tone="violet" label="PLAN TASKS" onPress={onPlanTasks} />
        ) : (
          <View style={styles.gateRow}>
            <ActionBtn
              tone="muted"
              disabled
              label={
                architectureState === "empty"
                  ? "PLAN TASKS · ARCH EMPTY"
                  : "PLAN TASKS · ARCH NOT APPROVED"
              }
              onPress={() => undefined}
            />
            <Text style={styles.gateHint}>
              {architectureState === "empty"
                ? "Add at least one service on the Architecture tab, then approve it."
                : "Open the Architecture tab and click Approve to unlock planning."}
            </Text>
          </View>
        )
      )}
      {status === "planning" && (
        <ActionBtn tone="muted" label="PLANNING…" disabled onPress={() => undefined} />
      )}
    </View>
  );
}

function ActionBtn({
  tone,
  label,
  onPress,
  disabled,
  variant = "solid",
}: {
  tone: "cyan" | "green" | "amber" | "violet" | "muted";
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "solid" | "ghost";
}) {
  const t = toneStyle(tone);
  const ghost = variant === "ghost";
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionBtn,
        {
          borderColor: t.border,
          backgroundColor: ghost ? "transparent" : t.bg,
        },
        !ghost ? glow(t.glow, 8) : undefined,
        pressed && !disabled ? styles.actionBtnPressed : undefined,
        disabled && styles.actionBtnDisabled,
      ]}
    >
      <Text style={[styles.actionLabel, { color: t.fg }]}>{label}</Text>
    </Pressable>
  );
}

function toneStyle(tone: "cyan" | "green" | "amber" | "violet" | "muted"): {
  fg: string;
  bg: string;
  border: string;
  glow: string;
} {
  switch (tone) {
    case "cyan":
      return { fg: palette.cyan, bg: "rgba(92,246,255,0.08)", border: palette.cyanDim, glow: palette.cyanGlow };
    case "green":
      return { fg: palette.green, bg: "rgba(118,245,176,0.08)", border: "rgba(118,245,176,0.4)", glow: "rgba(118,245,176,0.4)" };
    case "amber":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.08)", border: "rgba(255,180,84,0.4)", glow: "rgba(255,180,84,0.4)" };
    case "violet":
      return { fg: palette.violet, bg: "rgba(183,139,255,0.1)", border: "rgba(183,139,255,0.42)", glow: "rgba(183,139,255,0.4)" };
    case "muted":
      return { fg: palette.textMuted, bg: "transparent", border: palette.borderSoft, glow: "transparent" };
  }
}

// ---- States ----

function EmptyState({ status }: { status: FeatureStatus }) {
  if (status === "draft") {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          Add at least one node to this feature's flow before requesting a review.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>
        No council run yet. The council is a 5-lens review (Product, UX, Architecture, Security,
        Operability) that surfaces concerns before engineering commits to building. The user
        always has final say — the council never auto-approves.
      </Text>
    </View>
  );
}

function RunningIndicator({ label }: { label: string }) {
  return (
    <View style={styles.running}>
      <Text style={styles.runningDot}>●</Text>
      <Text style={styles.runningLabel}>{label}</Text>
    </View>
  );
}

function FailureCard({ error, startedAt }: { error: string; startedAt: number }) {
  return (
    <View style={styles.failure}>
      <Text style={styles.failureKicker}>// FAILED</Text>
      <Text style={styles.failureWhen}>{relativeTime(startedAt)}</Text>
      <Text style={styles.failureBody} numberOfLines={6}>
        {error}
      </Text>
      <Text style={styles.failureHint}>
        You can re-run the review (the council will retry once internally on parse failures).
      </Text>
    </View>
  );
}

// ---- Result (chair + lenses) ----

function ReviewResult({
  result,
  startedAt,
  resolvedPersonas,
}: {
  result: FlowReviewResult;
  startedAt: number;
  resolvedPersonas?: ResolvedPersona[];
}) {
  // Build a lens-key → accent lookup so each LensCard gets O(1)
  // access to its persona color without re-walking the array.
  // Falls back to null when the lens isn't in the resolved panel
  // (e.g. a stale run from before a persona was archived).
  const accentByKey = new Map<string, ResolvedPersona["accent"]>();
  for (const p of resolvedPersonas ?? []) {
    if (p.accent) accentByKey.set(p.key, p.accent);
  }
  return (
    <View style={styles.resultRoot}>
      <ChairCard chair={result.chair} startedAt={startedAt} />
      <View style={styles.lensGrid}>
        {/*
         * Phase 14: iterate the result's actual lens list (which is
         * already in resolved-persona order: defaults first, then
         * custom additions). Used to walk a hardcoded `LENS_IDS`
         * constant; that broke as soon as a project added a
         * "marketing" lens or replaced "ux".
         */}
        {result.lenses.map((lens) => (
          <LensCard
            key={lens.lens}
            lens={lens}
            accent={accentByKey.get(lens.lens) ?? null}
          />
        ))}
      </View>
    </View>
  );
}

function ChairCard({ chair, startedAt }: { chair: ChairReport; startedAt: number }) {
  const t = verdictTone(chair.overall_verdict);
  return (
    <View style={[styles.chair, { borderColor: t.border, backgroundColor: t.bg }]}>
      <View style={styles.chairHead}>
        <Text style={styles.chairKicker}>// CHAIR</Text>
        <Text style={[styles.chairVerdict, { color: t.fg }]}>
          {chair.overall_verdict.replace("_", " ").toUpperCase()}
        </Text>
        <Text style={styles.chairWhen}>{relativeTime(startedAt)}</Text>
      </View>
      <Text style={styles.chairRecommendation}>{chair.recommendation}</Text>
      {chair.top_concerns.length > 0 ? (
        <View style={styles.chairConcerns}>
          <Text style={styles.chairConcernsLabel}>TOP CONCERNS</Text>
          {chair.top_concerns.map((c, i) => (
            <Text key={i} style={styles.chairConcernsItem}>
              • {c}
            </Text>
          ))}
        </View>
      ) : null}
      {chair.must_address_count > 0 ? (
        <Text style={styles.chairMustCount}>
          {chair.must_address_count} must-address {chair.must_address_count === 1 ? "finding" : "findings"} across the lenses
        </Text>
      ) : null}
    </View>
  );
}

function LensCard({
  lens,
  accent,
}: {
  lens: LensReport;
  accent: ResolvedPersona["accent"] | null;
}) {
  const t = verdictTone(lens.verdict);
  const [expanded, setExpanded] = useState(false);
  const findings = lens.findings;
  const mustCount = findings.filter((f) => f.must_address).length;
  const accentColor = personaAccentColor(accent);

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={({ pressed }) => [
        styles.lens,
        { borderColor: t.border, backgroundColor: t.bg },
        pressed && styles.lensPressed,
      ]}
    >
      {accentColor ? (
        // Persona accent painted as a 3px left edge so the verdict
        // border (which carries approve/changes signal) stays the
        // dominant outline. The eye reads accent → "this is the
        // marketing lens", and the border read → "marketing said
        // request_changes". Both signals coexist without fighting.
        <View
          style={[styles.lensAccent, { backgroundColor: accentColor }]}
          pointerEvents="none"
        />
      ) : null}
      <View style={styles.lensHead}>
        <Text
          style={[
            styles.lensName,
            accentColor ? { color: accentColor } : undefined,
          ]}
        >
          {lens.lens.toUpperCase()}
        </Text>
        <Text style={[styles.lensVerdict, { color: t.fg }]}>
          {lens.verdict.replace("_", " ")}
        </Text>
      </View>
      <Text style={styles.lensReasoning} numberOfLines={expanded ? undefined : 2}>
        {lens.reasoning}
      </Text>
      {findings.length > 0 ? (
        <View style={styles.lensFindings}>
          {(expanded ? findings : findings.slice(0, 2)).map((f, i) => (
            <Finding key={i} finding={f} />
          ))}
          {!expanded && findings.length > 2 ? (
            <Text style={styles.lensMore}>
              +{findings.length - 2} more · tap to expand
            </Text>
          ) : null}
        </View>
      ) : (
        <Text style={styles.lensNoFindings}>no findings</Text>
      )}
      {mustCount > 0 ? (
        <Text style={styles.lensMustCount}>
          {mustCount} must-address
        </Text>
      ) : null}
    </Pressable>
  );
}

function Finding({ finding }: { finding: CouncilFinding }) {
  const sev = severityTone(finding.severity);
  return (
    <View style={styles.finding}>
      <View style={[styles.findingDot, { backgroundColor: sev.fg }]} />
      <View style={styles.findingBody}>
        <View style={styles.findingHead}>
          <Text style={[styles.findingSev, { color: sev.fg }]}>{finding.severity}</Text>
          {finding.must_address ? (
            <Text style={styles.findingMust}>· must-address</Text>
          ) : null}
        </View>
        <Text style={styles.findingSummary}>{finding.summary}</Text>
      </View>
    </View>
  );
}

// ---- Status pill ----

function StatusChip({ status }: { status: FeatureStatus }) {
  const tone = statusTone(status);
  return (
    <View style={[styles.statusChip, { borderColor: tone.border, backgroundColor: tone.bg }]}>
      <Text style={[styles.statusChipText, { color: tone.fg }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

function statusTone(s: FeatureStatus): { fg: string; bg: string; border: string } {
  switch (s) {
    case "draft": return { fg: palette.textSecondary, bg: "rgba(80,96,116,0.18)", border: palette.borderHair };
    case "flowing": return { fg: palette.cyan, bg: "rgba(92,246,255,0.06)", border: "rgba(92,246,255,0.32)" };
    case "flow_review": return { fg: palette.amber, bg: "rgba(255,180,84,0.07)", border: "rgba(255,180,84,0.32)" };
    case "flow_approved": return { fg: palette.violet, bg: "rgba(183,139,255,0.08)", border: "rgba(183,139,255,0.34)" };
    case "planning": return { fg: palette.amber, bg: "rgba(255,180,84,0.08)", border: "rgba(255,180,84,0.4)" };
    case "planned": return { fg: palette.violet, bg: "rgba(183,139,255,0.1)", border: "rgba(183,139,255,0.42)" };
    case "in_progress": return { fg: palette.amber, bg: "rgba(255,180,84,0.08)", border: "rgba(255,180,84,0.4)" };
    case "done": return { fg: palette.green, bg: "rgba(118,245,176,0.08)", border: "rgba(118,245,176,0.34)" };
    default: return { fg: palette.textMuted, bg: "rgba(80,96,116,0.12)", border: palette.borderSoft };
  }
}

function verdictTone(v: Verdict): { fg: string; bg: string; border: string } {
  switch (v) {
    case "approve":
      return { fg: palette.green, bg: "rgba(118,245,176,0.06)", border: "rgba(118,245,176,0.32)" };
    case "approve_with_notes":
      return { fg: palette.cyan, bg: "rgba(92,246,255,0.06)", border: "rgba(92,246,255,0.32)" };
    case "request_changes":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.06)", border: "rgba(255,180,84,0.34)" };
  }
}

function severityTone(s: Severity): { fg: string } {
  switch (s) {
    case "info": return { fg: palette.textMuted };
    case "minor": return { fg: palette.cyan };
    case "major": return { fg: palette.amber };
    case "blocking": return { fg: palette.danger };
  }
}

function relativeTime(ts: number): string {
  const dMs = Date.now() - ts;
  if (dMs < 60_000) return `${Math.max(1, Math.floor(dMs / 1000))}s ago`;
  if (dMs < 3_600_000) return `${Math.floor(dMs / 60_000)}m ago`;
  if (dMs < 86_400_000) return `${Math.floor(dMs / 3_600_000)}h ago`;
  return `${Math.floor(dMs / 86_400_000)}d ago`;
}

// ---- Styles ----

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minWidth: 320,
    maxWidth: 460,
    backgroundColor: palette.bgRaised,
    borderLeftWidth: 1,
    borderLeftColor: palette.borderHair,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
  },
  kicker: { color: palette.violet, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  statusChipText: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2, fontWeight: "600" },

  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  actionBtnPressed: { opacity: 0.85 },
  actionBtnDisabled: { opacity: 0.45 },
  actionLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, fontWeight: "700" },
  gateRow: { flexBasis: "100%", gap: 4 },
  gateHint: {
    color: palette.amber,
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
    fontStyle: "italic",
  },

  body: { flex: 1 },
  bodyContent: { padding: space.md, gap: space.sm },

  empty: {
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(15,22,38,0.5)",
  },
  emptyText: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 18,
  },

  running: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: "rgba(92,246,255,0.06)",
  },
  runningDot: {
    color: palette.cyan,
    fontSize: 16,
  },
  runningLabel: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 0.6 },

  failure: {
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.danger,
    backgroundColor: "rgba(255,107,107,0.06)",
    gap: 4,
  },
  failureKicker: { color: palette.danger, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6, fontWeight: "700" },
  failureWhen: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6 },
  failureBody: { color: palette.textPrimary, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, marginTop: 4 },
  failureHint: { color: palette.textMuted, fontFamily: fonts.body, fontSize: 11, marginTop: 8, fontStyle: "italic" },

  resultRoot: { gap: space.sm },
  chair: {
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 6,
  },
  chairHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  chairKicker: { color: palette.violet, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.6 },
  chairVerdict: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700", flex: 1 },
  chairWhen: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9 },
  chairRecommendation: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  chairConcerns: { marginTop: 6, gap: 2 },
  chairConcernsLabel: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.6 },
  chairConcernsItem: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
  chairMustCount: { color: palette.amber, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6, marginTop: 4 },

  lensGrid: { gap: space.sm },
  lens: {
    padding: space.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 4,
    position: "relative",
    overflow: "hidden",
  },
  // Persona accent — a thin left edge so each lens reads as
  // "this is the marketing lens / security lens / etc." even
  // when verdicts (the border) are all the same.
  lensAccent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: radii.md,
    borderBottomLeftRadius: radii.md,
  },
  lensPressed: { opacity: 0.92 },
  lensHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  lensName: { color: palette.textPrimary, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
  lensVerdict: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, fontWeight: "600" },
  lensReasoning: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  lensFindings: { marginTop: 4, gap: 4 },
  lensMore: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6, fontStyle: "italic" },
  lensNoFindings: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10, fontStyle: "italic" },
  lensMustCount: { color: palette.amber, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6, fontWeight: "600", marginTop: 4 },

  finding: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  findingDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  findingBody: { flex: 1 },
  findingHead: { flexDirection: "row", alignItems: "center", gap: 4 },
  findingSev: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontWeight: "700" },
  findingMust: { color: palette.amber, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6 },
  findingSummary: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
});
