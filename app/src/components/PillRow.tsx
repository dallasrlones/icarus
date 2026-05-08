import { StyleSheet, Text, View } from "react-native";
import type { Pill } from "../types";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Renders the agent's `icarus` action blocks as pills inside an assistant
 * bubble. Each pill represents one fenced JSON command:
 *   - pending  → the fence is still streaming
 *   - applied  → the mutation succeeded; we show kind + a one-line summary
 *   - rejected → the JSON failed to parse or apply; we show the error
 */

interface Props {
  pills: Pill[];
}

export function PillRow({ pills }: Props) {
  if (!pills || pills.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {pills.map((p) => (
        <PillChip key={p.id} pill={p} />
      ))}
    </View>
  );
}

function PillChip({ pill }: { pill: Pill }) {
  const tone = toneFor(pill.phase);
  return (
    <View
      style={[
        styles.chip,
        { borderColor: tone.border, backgroundColor: tone.bg },
        pill.phase === "pending" ? glow(palette.cyanGlow, 14) : undefined,
      ]}
    >
      <Text style={[styles.icon, { color: tone.fg }]}>{symbolFor(pill.phase)}</Text>
      <View style={styles.chipBody}>
        <Text style={[styles.label, { color: tone.fg }]}>
          {labelFor(pill)}
        </Text>
        {pill.phase === "rejected" && pill.error ? (
          <Text style={styles.subtle} numberOfLines={2}>
            {pill.error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function symbolFor(phase: Pill["phase"]): string {
  switch (phase) {
    case "pending": return "▶";
    case "applied": return "✔";
    case "rejected": return "✕";
  }
}

function labelFor(pill: Pill): string {
  if (pill.phase === "pending") {
    return "preparing action…";
  }
  if (pill.phase === "applied") {
    const slug = (pill.result as { project?: { slug?: string } } | undefined)?.project?.slug
      ?? (pill.result as { slug?: string } | undefined)?.slug;
    return slug ? `${pill.kind ?? "action"} → ${slug}` : pill.kind ?? "action applied";
  }
  return `rejected ${pill.kind ?? "action"}`;
}

function toneFor(phase: Pill["phase"]): { fg: string; bg: string; border: string } {
  switch (phase) {
    case "pending":
      return {
        fg: palette.cyan,
        bg: "rgba(92, 246, 255, 0.06)",
        border: "rgba(92, 246, 255, 0.32)",
      };
    case "applied":
      return {
        fg: palette.green,
        bg: "rgba(118, 245, 176, 0.07)",
        border: "rgba(118, 245, 176, 0.32)",
      };
    case "rejected":
      return {
        fg: palette.danger,
        bg: palette.dangerDim,
        border: "rgba(255, 107, 107, 0.42)",
      };
  }
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "column",
    gap: 6,
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderSoft,
  },
  chip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  icon: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 16,
  },
  chipBody: {
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  subtle: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
});
