import { useEffect, useRef, type ReactElement } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useChatStore } from "../store";
import { palette, fonts, glow, radii, space } from "../theme";

/**
 * Phase 15 — floating push-to-talk mic button + preview bubble.
 *
 * Two stacked elements anchored bottom-right of the viewport:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ Preview bubble (only when pending)      │
 *   │  - editable transcript                  │
 *   │  - Re-record / Send / Discard actions   │
 *   └─────────────────────────────────────────┘
 *               ┌──────────────┐
 *               │  TALK button │
 *               └──────────────┘
 *
 * State machine drives the colors / labels:
 *   idle         → cyan,   "TALK"
 *   recording    → red,    "STOP"           (with pulsing dot)
 *   transcribing → amber,  "TRANSCRIBING…"  (button disabled)
 *   pending      → cyan,   "RE-RECORD"      (preview bubble visible)
 *   speaking     → violet, "SPEAKING…"      (click cancels playback)
 *
 * Web-only — `recorderSupported()` already gates `voice.available`,
 * so on native this whole component returns `null`.
 */

export function VoiceButton(): ReactElement | null {
  const voice = useChatStore((s) => s.voice);
  const arm = useChatStore((s) => s.voiceArm);
  const stopAndPreview = useChatStore((s) => s.voiceStopAndPreview);
  const editPending = useChatStore((s) => s.voiceEditPending);
  const confirmAndSend = useChatStore((s) => s.voiceConfirmAndSend);
  const discardPending = useChatStore((s) => s.voiceDiscardPending);
  const cancel = useChatStore((s) => s.voiceCancel);
  const clearTarget = useChatStore((s) => s.clearVoiceTarget);

  if (Platform.OS !== "web") return null;
  if (!voice.available) return null;

  const targetIsQuestion = voice.target.kind === "question";
  const questionPreview =
    voice.target.kind === "question" ? voice.target.preview : null;

  const onPressMain = () => {
    switch (voice.state) {
      case "idle":
      case "pending":
        // From pending, clicking the mic starts a fresh recording —
        // arm() clears pendingTranscript so the new utterance fully
        // replaces. This is the "talk to change it" path.
        void arm();
        return;
      case "recording":
        void stopAndPreview();
        return;
      case "speaking":
        cancel();
        return;
      // transcribing: ignore — operation in flight.
    }
  };

  const accent = colorForState(voice.state);
  const label = labelForState(voice.state);
  const disabled = voice.state === "transcribing";

  return (
    <View pointerEvents="box-none" style={styles.anchor}>
      {voice.state === "pending" && voice.pendingTranscript !== null ? (
        <PreviewBubble
          transcript={voice.pendingTranscript}
          questionPreview={targetIsQuestion ? questionPreview : null}
          onChange={editPending}
          onSend={() => void confirmAndSend()}
          onRerecord={() => void arm()}
          onDiscard={discardPending}
        />
      ) : null}

      {/*
        Phase 15.2 — when a question is locked as the voice target
        but no transcript is pending yet (user clicked SPEAK, the
        audio is playing or just finished), show a thin banner so
        the user remembers their next utterance answers a
        question, not the chat. Click ✕ to back out without
        recording. Hidden during pending because the preview
        bubble already carries the same context inline.
      */}
      {targetIsQuestion && voice.state !== "pending" ? (
        <View style={styles.targetBanner}>
          <Text style={styles.targetBannerLabel}>→ ANSWERING</Text>
          <Text style={styles.targetBannerBody} numberOfLines={2}>
            {questionPreview}
          </Text>
          <Pressable
            onPress={clearTarget}
            style={({ pressed }) => [
              styles.targetBannerClose,
              pressed && { opacity: 0.7 },
            ]}
            accessibilityLabel="Cancel question voice target"
          >
            <Text style={styles.targetBannerCloseText}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        onPress={onPressMain}
        disabled={disabled}
        style={({ pressed }) => [
          styles.button,
          {
            borderColor: accent,
            backgroundColor: pressed ? "rgba(15, 22, 38, 0.92)" : palette.bgPanel,
          },
          glow(`${accent}77`, voice.state === "recording" ? 28 : 18),
          disabled && { opacity: 0.6 },
        ]}
        accessibilityLabel={`Voice button: ${label}`}
      >
        {voice.state === "recording" ? (
          <PulseDot color={accent} />
        ) : (
          <MicGlyph color={accent} />
        )}
        <Text style={[styles.stateLabel, { color: accent }]}>{label}</Text>
      </Pressable>

      {voice.error ? (
        <View style={styles.errorPill}>
          <Text style={styles.errorText}>{voice.error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function colorForState(
  state: "idle" | "recording" | "transcribing" | "pending" | "speaking",
): string {
  switch (state) {
    case "recording": return palette.danger;
    case "transcribing": return palette.amber;
    case "speaking": return palette.violet;
    // pending uses cyan (same as idle) so the user reads the bubble
    // for the actual call-to-action. Different label ("RE-RECORD")
    // disambiguates.
    default: return palette.cyan;
  }
}

function labelForState(
  state: "idle" | "recording" | "transcribing" | "pending" | "speaking",
): string {
  switch (state) {
    case "recording": return "STOP";
    case "transcribing": return "TRANSCRIBING…";
    case "pending": return "RE-RECORD";
    case "speaking": return "SPEAKING…";
    default: return "TALK";
  }
}

/**
 * The "show me what I'm saying so I can confirm" surface.
 *
 * Editable so a misheard proper noun can be fixed with the keyboard
 * instead of forcing a re-record. The Send button doubles as a
 * keyboard-Enter-equivalent — pressing Cmd/Ctrl+Enter inside the
 * field also fires onSend (web only).
 */
function PreviewBubble(props: {
  transcript: string;
  /**
   * Phase 15.2 — when the voice target is locked to a question,
   * the bubble surfaces a "→ Answering: <q>" header so the user
   * knows their SEND fires `answer_question` instead of a normal
   * chat message. `null` (or undefined) means "going to chat".
   */
  questionPreview: string | null;
  onChange: (text: string) => void;
  onSend: () => void;
  onRerecord: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { transcript, questionPreview, onChange, onSend, onRerecord, onDiscard } = props;

  // Detect Enter on web for one-keystroke confirm. RN Native's
  // TextInput exposes onSubmitEditing for the same behavior, but we
  // only render on web so this `as any` lets us hand a DOM keydown
  // handler down without TS friction.
  const onKeyPress = (ev: { nativeEvent: { key: string } }) => {
    if (ev.nativeEvent.key === "Enter") {
      onSend();
    }
  };

  return (
    <View style={bubbleStyles.frame} accessibilityLabel="Voice transcript preview">
      {questionPreview ? (
        // Soft inset reading "→ Answering: <q>" so the user can't
        // miss that SEND is going to fire `answer_question`. Same
        // cyan accent the question card carries when locked, so
        // the visual link reads naturally.
        <View style={bubbleStyles.questionTag}>
          <Text style={bubbleStyles.questionTagLabel}>→ ANSWERING</Text>
          <Text style={bubbleStyles.questionTagBody} numberOfLines={2}>
            {questionPreview}
          </Text>
        </View>
      ) : null}
      <Text style={bubbleStyles.heading}>HEARD YOU SAY</Text>
      <TextInput
        value={transcript}
        onChangeText={onChange}
        onKeyPress={onKeyPress as never}
        multiline
        placeholder="(empty)"
        placeholderTextColor={palette.textMuted}
        style={bubbleStyles.input}
        autoFocus
      />
      <View style={bubbleStyles.actionRow}>
        <ActionButton
          label="DISCARD"
          color={palette.textSecondary}
          onPress={onDiscard}
        />
        <ActionButton
          label="RE-RECORD"
          color={palette.cyan}
          onPress={onRerecord}
        />
        <ActionButton
          label={questionPreview ? "SEND ANSWER" : "SEND"}
          color={palette.green}
          onPress={onSend}
          emphasized
        />
      </View>
      <Text style={bubbleStyles.hint}>
        Edit, hit ↵ to send, click the mic to redo, or ✕ to cancel.
      </Text>
    </View>
  );
}

function ActionButton(props: {
  label: string;
  color: string;
  onPress: () => void;
  emphasized?: boolean;
}): ReactElement {
  const { label, color, onPress, emphasized } = props;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        bubbleStyles.actionButton,
        {
          borderColor: color,
          backgroundColor: emphasized
            ? pressed
              ? `${color}33`
              : `${color}22`
            : pressed
              ? "rgba(15, 22, 38, 0.92)"
              : "rgba(15, 22, 38, 0.4)",
        },
      ]}
    >
      <Text style={[bubbleStyles.actionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

function MicGlyph({ color }: { color: string }): ReactElement {
  return (
    <View style={micStyles.frame}>
      <View style={[micStyles.capsule, { backgroundColor: color }]} />
      <View style={[micStyles.bracket, { borderColor: color }]} />
      <View style={[micStyles.stem, { backgroundColor: color }]} />
    </View>
  );
}

function PulseDot({ color }: { color: string }): ReactElement {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 600,
          easing: Easing.in(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);

  const ringScale = value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const ringOpacity = value.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  return (
    <View style={pulseStyles.frame}>
      <Animated.View
        style={[
          pulseStyles.ring,
          {
            borderColor: color,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          },
        ]}
      />
      <View style={[pulseStyles.dot, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: ((Platform.OS === "web" ? "fixed" : "absolute") as unknown) as "absolute",
    right: 24,
    bottom: 24,
    alignItems: "flex-end",
    zIndex: 9999,
    gap: 8,
  } as any,
  button: {
    minWidth: 132,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  stateLabel: {
    fontFamily: fonts.body,
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: "700",
  },
  errorPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerDim,
    borderWidth: 1,
    borderColor: palette.danger,
    maxWidth: 320,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: palette.danger,
  },
  // Voice target banner — sits between the bubble and the mic
  // button when a question is locked but no transcript is pending
  // yet. Mirrors the cyan-accent treatment on the question card.
  targetBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: "rgba(92, 246, 255, 0.06)",
    maxWidth: 360,
  },
  targetBannerLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.4,
    fontWeight: "700",
    color: palette.cyan,
  },
  targetBannerBody: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: palette.textPrimary,
  },
  targetBannerClose: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  targetBannerCloseText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: palette.textMuted,
  },
});

const bubbleStyles = StyleSheet.create({
  frame: {
    width: 360,
    maxWidth: "90vw" as unknown as number, // RN-Web only; harmless cast.
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.bgPanel,
    padding: space.md,
    gap: space.sm,
    ...glow(palette.cyanGlow, 24),
  },
  heading: {
    fontFamily: fonts.body,
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: "700",
    color: palette.cyan,
  },
  input: {
    minHeight: 48,
    maxHeight: 180,
    fontFamily: fonts.body,
    fontSize: 14,
    color: palette.textPrimary,
    backgroundColor: "rgba(5, 7, 13, 0.6)",
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    // RN-Web maps this through to CSS resize.
    ...(Platform.OS === "web" ? ({ resize: "vertical" } as object) : {}),
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.sm,
  },
  actionButton: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  actionLabel: {
    fontFamily: fonts.body,
    fontSize: 11,
    letterSpacing: 1.1,
    fontWeight: "700",
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: palette.textMuted,
    fontStyle: "italic",
  },
  // Phase 15.2 — "→ Answering: <q>" inset at the top of the
  // bubble when voice target is a question. Visually lighter than
  // the heading so it reads as context, not the call to action.
  questionTag: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderLeftWidth: 2,
    borderLeftColor: palette.cyan,
    backgroundColor: "rgba(92, 246, 255, 0.05)",
    borderRadius: radii.sm,
    gap: 2,
  },
  questionTagLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.4,
    fontWeight: "700",
    color: palette.cyan,
  },
  questionTagBody: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: palette.textPrimary,
    lineHeight: 16,
  },
});

const micStyles = StyleSheet.create({
  frame: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  capsule: {
    width: 8,
    height: 12,
    borderRadius: 4,
    position: "absolute",
    top: 2,
  },
  bracket: {
    width: 16,
    height: 12,
    borderRadius: 8,
    borderWidth: 2,
    borderTopColor: "transparent",
    position: "absolute",
    bottom: 2,
  },
  stem: {
    width: 2,
    height: 4,
    position: "absolute",
    bottom: 0,
  },
});

const pulseStyles = StyleSheet.create({
  frame: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
