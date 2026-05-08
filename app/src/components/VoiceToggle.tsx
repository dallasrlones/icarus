import { Pressable, StyleSheet, Text, View } from "react-native";
import { useChatStore } from "../store";
import { fonts, palette, radii, space } from "../theme";
import { applyMutation } from "../api";

/**
 * Phase 19 — Voice toggle pill.
 *
 * Sits in the sidebar next to the cursor usage pill. Three
 * visual states drive off the existing voice slice in the store
 * (no extra polling — the store already refreshes voice health
 * on WS `voice_settings_changed` events and on a periodic timer):
 *
 *   - ON · healthy   → green dot, "VOICE ON". Mic button is
 *                      visible everywhere it normally would be.
 *   - ON · offline   → amber dot, "VOICE OFFLINE". Server can't
 *                      reach the upstream STT/TTS service (you're
 *                      probably off-LAN). Mic button is hidden.
 *                      Tap to flip OFF and stop probing — saves
 *                      the 4-second timeout per /v1/voice/health
 *                      poll while away from the local network.
 *   - OFF · user     → muted dot, "VOICE OFF". User flipped the
 *                      global toggle. Server skips the upstream
 *                      probe entirely; voice POST endpoints
 *                      fast-fail with 503. Tap to flip back ON.
 *
 * The toggle dispatches a `set_voice_enabled` mutation, which
 * the server broadcasts via WS so all open tabs flip together.
 */

type ToggleState =
  | { kind: "on_healthy" }
  | { kind: "on_offline"; reason?: string }
  | { kind: "off_user" };

function readState(voice: { available: boolean; userDisabled: boolean; healthReason?: string }): ToggleState {
  if (voice.userDisabled) return { kind: "off_user" };
  if (voice.available) return { kind: "on_healthy" };
  return { kind: "on_offline", reason: voice.healthReason };
}

export function VoiceToggle() {
  const voice = useChatStore((s) => s.voice);
  const refreshVoiceHealth = useChatStore((s) => s.refreshVoiceHealth);
  const state = readState(voice);

  const onPress = async () => {
    // Toggle off when currently on (either healthy or offline)
    // and on when currently off. The server broadcasts the new
    // state so the WS handler will refresh us; we also force a
    // refresh here so the pill updates instantly even if the WS
    // is briefly disconnected.
    const nextEnabled = state.kind === "off_user";
    try {
      await applyMutation({
        kind: "set_voice_enabled",
        payload: { enabled: nextEnabled },
      });
    } catch {
      // Best-effort: the WS event is the canonical source of truth.
      // If the mutation failed we'll see the next health poll.
    }
    void refreshVoiceHealth();
  };

  const dotColor =
    state.kind === "on_healthy"
      ? palette.green
      : state.kind === "on_offline"
        ? palette.amber
        : palette.textMuted;

  const labelText =
    state.kind === "on_healthy"
      ? "VOICE ON"
      : state.kind === "on_offline"
        ? "VOICE OFFLINE"
        : "VOICE OFF";

  const subText =
    state.kind === "on_healthy"
      ? "tap to disable"
      : state.kind === "on_offline"
        ? "upstream unreachable — tap to disable"
        : "tap to enable";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      accessibilityRole="switch"
      accessibilityState={{ checked: state.kind !== "off_user" }}
      accessibilityLabel={`Voice ${state.kind === "off_user" ? "off" : "on"}. Tap to toggle.`}
    >
      <View style={styles.headerRow}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.label}>{labelText}</Text>
      </View>
      <Text style={styles.subText} numberOfLines={1}>
        {subText}
      </Text>
    </Pressable>
  );
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    color: palette.textPrimary,
  },
  subText: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: palette.textMuted,
    marginTop: 4,
  },
});
