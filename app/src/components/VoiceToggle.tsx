import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useChatStore } from "../store";
import { fonts, palette, radii, space } from "../theme";
import { applyMutation } from "../api";

/**
 * Phase 19 — Voice toggle pill.
 *
 * Sits in the sidebar next to the cursor usage pill. Three
 * visual states drive off the existing voice slice in the store
 * (startup poll + WS `voice_settings_changed` + ≈20s health poll while
 * voice is enabled — avoids sticking OFFLINE after a slow Jetson TTS boot):
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
  const setVoiceState = useChatStore((s) => s.setVoiceState);
  const [toggling, setToggling] = useState(false);
  const state = readState(voice);

  const offlineHint =
    state.kind === "on_offline" && voice.healthReason
      ? voice.healthReason.length > 72
        ? `${voice.healthReason.slice(0, 69)}…`
        : voice.healthReason
      : null;

  const onPress = async () => {
    if (toggling) return;
    // Toggle off when currently on (either healthy or offline)
    // and on when currently off. Optimistically patch the store so
    // the pill flips immediately; then await health so we match
    // the server (WS may also refresh other tabs).
    const nextEnabled = state.kind === "off_user";
    setToggling(true);
    setVoiceState(
      nextEnabled
        ? { userDisabled: false }
        : {
            userDisabled: true,
            available: false,
            healthReason: "voice disabled by user",
          },
    );
    try {
      await applyMutation({
        kind: "set_voice_enabled",
        payload: { enabled: nextEnabled },
      });
      await refreshVoiceHealth();
    } catch {
      await refreshVoiceHealth();
    } finally {
      setToggling(false);
    }
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
        ? offlineHint
          ? `${offlineHint} · tap to disable`
          : "upstream unreachable — tap to disable"
        : "tap to enable";

  return (
    <Pressable
      onPress={onPress}
      disabled={toggling}
      style={({ pressed }) => [
        styles.pill,
        pressed && !toggling && styles.pillPressed,
        toggling && styles.pillBusy,
      ]}
      accessibilityRole="switch"
      accessibilityState={{ checked: state.kind !== "off_user", busy: toggling }}
      accessibilityLabel={`Voice ${state.kind === "off_user" ? "off" : "on"}. Tap to toggle.`}
    >
      <View style={styles.headerRow}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.label}>{labelText}</Text>
      </View>
      <Text style={styles.subText} numberOfLines={2}>
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
  pillBusy: { opacity: 0.55 },
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
