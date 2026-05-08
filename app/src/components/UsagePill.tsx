import { useEffect, useState, useCallback } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { fonts, palette, radii, space } from "../theme";
import { getCursorUsage, type CursorUsageResult } from "../api";

/**
 * Phase 17 — Cursor usage pill.
 *
 * Lives at the bottom of the sidebar so it's visible in both the
 * global cockpit and per-project views. Polls `/v1/cursor/usage`
 * once on mount, then every 5 minutes; click to force-refresh.
 *
 * The server-side endpoint never throws on auth/proxy failures —
 * it returns an `unavailable` envelope with a reason. We render
 * both shapes so the pill stays present in degraded mode and
 * funnels the user to `cursor.com/dashboard`.
 *
 * Color logic for the gauge:
 *   - cyan       <  60%
 *   - amber 60–84%
 *   - rose       >= 85%
 *
 * The percent reading is `planUsage.totalPercentUsed` from the
 * dashboard service when present (the same number the Cursor
 * web dashboard shows). When the field is missing we compute
 * `includedSpend / limit * 100` as a deterministic fallback.
 */

const POLL_MS = 5 * 60 * 1000;

export function UsagePill() {
  const [usage, setUsage] = useState<CursorUsageResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const u = await getCursorUsage(force);
      setUsage(u);
    } catch {
      // Network failure (server unreachable). Render a degraded
      // "no data" pill instead of crashing the sidebar.
      setUsage({
        status: "unavailable",
        reason: "icarus-server unreachable",
        dashboardUrl: "https://cursor.com/dashboard",
        fetchedAt: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const isPressable = !!usage;
  const onPress = () => {
    if (!usage) return;
    if (usage.status === "unavailable") {
      void Linking.openURL(usage.dashboardUrl);
    } else {
      void load(true);
    }
  };

  return (
    <Pressable
      onPress={isPressable ? onPress : undefined}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      accessibilityRole="button"
      accessibilityLabel={
        usage?.status === "ok"
          ? `Cursor usage: ${Math.round(usage.spend.percentUsed)} percent. Tap to refresh.`
          : "Cursor usage unavailable. Tap to open dashboard."
      }
    >
      <Text style={styles.label}>// CURSOR USAGE</Text>
      {usage?.status === "ok" ? (
        <OkBody usage={usage} loading={loading} />
      ) : usage?.status === "unavailable" ? (
        <UnavailableBody reason={usage.reason} />
      ) : (
        <Text style={styles.dimText}>loading…</Text>
      )}
    </Pressable>
  );
}

function OkBody({
  usage,
  loading,
}: {
  usage: Extract<CursorUsageResult, { status: "ok" }>;
  loading: boolean;
}) {
  const pct = clamp(usage.spend.percentUsed, 0, 100);
  const barColor =
    pct >= 85 ? palette.rose : pct >= 60 ? palette.amber : palette.cyan;
  const cycleEndMs = usage.cycle.endMs;
  const daysLeft =
    cycleEndMs > 0 ? Math.max(0, Math.round((cycleEndMs - Date.now()) / 86_400_000)) : null;

  return (
    <>
      <View style={styles.row}>
        <Text style={styles.planName} numberOfLines={1}>
          {usage.plan.name.toUpperCase()}
        </Text>
        <Text style={[styles.percent, { color: barColor }]}>
          {pct >= 100 ? "100%" : `${pct.toFixed(0)}%`}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${pct}%`, backgroundColor: barColor },
          ]}
        />
      </View>
      <View style={styles.row}>
        <Text style={styles.dimText} numberOfLines={1}>
          ${(usage.spend.includedCents / 100).toFixed(0)} / $
          {(usage.plan.includedCents / 100).toFixed(0)}
        </Text>
        {daysLeft !== null ? (
          <Text style={styles.dimText}>
            {daysLeft === 0 ? "<1d" : `${daysLeft}d`}
          </Text>
        ) : null}
      </View>
      {usage.spend.bonusCents > 0 ? (
        <Text style={styles.bonus} numberOfLines={1}>
          +${(usage.spend.bonusCents / 100).toFixed(0)} bonus
        </Text>
      ) : null}
      {loading ? <Text style={styles.refreshing}>refreshing…</Text> : null}
    </>
  );
}

function UnavailableBody({ reason }: { reason: string }) {
  return (
    <>
      <Text style={styles.unavailable}>unavailable</Text>
      <Text style={styles.dimText} numberOfLines={2}>
        {reason}
      </Text>
      <Text style={styles.dashboardLink}>open dashboard ↗</Text>
    </>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

const styles = StyleSheet.create({
  pill: {
    marginHorizontal: space.md,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: palette.bgPanel,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
  },
  pillPressed: { opacity: 0.7 },
  label: {
    fontFamily: fonts.body,
    fontSize: 9,
    letterSpacing: 1.5,
    color: palette.textMuted,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planName: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1.4,
    color: palette.textPrimary,
  },
  percent: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "600",
  },
  barTrack: {
    height: 4,
    backgroundColor: palette.borderSoft,
    borderRadius: 2,
    marginTop: 6,
    marginBottom: 6,
    overflow: "hidden",
  },
  barFill: {
    height: 4,
    borderRadius: 2,
  },
  dimText: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: palette.textSecondary,
  },
  bonus: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: palette.green,
    marginTop: 2,
  },
  refreshing: {
    fontFamily: fonts.body,
    fontSize: 9,
    color: palette.textMuted,
    marginTop: 2,
    fontStyle: "italic",
  },
  unavailable: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.amber,
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  dashboardLink: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: palette.cyan,
    marginTop: 4,
  },
});
