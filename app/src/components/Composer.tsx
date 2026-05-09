import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useCompactLayout } from "../layout/compact";
import { fonts, glow, palette, radii, space } from "../theme";

interface Props {
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const compact = useCompactLayout();

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const empty = text.trim().length === 0;
  const sendDisabled = disabled || empty;

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={styles.inputShell}>
        <Text style={styles.prompt}>{">"}</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={disabled ? "// awaiting agent…" : "// type to command icarus"}
          placeholderTextColor={palette.textMuted}
          editable={!disabled}
          style={styles.input}
          multiline
          onKeyPress={(e) => {
            if (Platform.OS !== "web") return;
            // @ts-expect-error: web event has the fields we need.
            if (e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
              e.preventDefault?.();
              submit();
            }
          }}
          onSubmitEditing={submit}
          returnKeyType="send"
          blurOnSubmit={false}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={submit}
        disabled={sendDisabled}
        style={({ pressed }) => [
          styles.sendBtn,
          compact && styles.sendBtnCompact,
          sendDisabled && styles.sendBtnDisabled,
          pressed && !sendDisabled && styles.sendBtnPressed,
          !sendDisabled && (glow(palette.cyanGlow, 18) as object),
        ]}
      >
        <Text style={[styles.sendBtnText, sendDisabled && styles.sendBtnTextDisabled]}>
          SEND
        </Text>
        <Text style={[styles.sendBtnArrow, sendDisabled && styles.sendBtnTextDisabled]}>
          ▸
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: space.md,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  wrapCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  inputShell: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(8, 11, 22, 0.85)",
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    minHeight: 44,
  },
  prompt: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 14,
    lineHeight: 22,
    paddingTop: 2,
  },
  input: {
    flex: 1,
    minHeight: 26,
    maxHeight: 160,
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
    outlineStyle: "none" as unknown as undefined,
    padding: 0,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyan,
    backgroundColor: "rgba(92, 246, 255, 0.10)",
  },
  sendBtnCompact: {
    alignSelf: "stretch",
    width: "100%",
  },
  sendBtnDisabled: {
    backgroundColor: "rgba(80, 96, 116, 0.12)",
    borderColor: palette.borderSoft,
  },
  sendBtnPressed: {
    backgroundColor: "rgba(92, 246, 255, 0.20)",
  },
  sendBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.6,
  },
  sendBtnArrow: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  sendBtnTextDisabled: {
    color: palette.textMuted,
  },
});
