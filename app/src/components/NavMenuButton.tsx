import { Pressable, StyleSheet, View } from "react-native";
import { glow, palette, radii } from "../theme";

interface Props {
  onPress: () => void;
}

/** Hamburger control — 44×44 minimum touch target for mobile. */
export function NavMenuButton({ onPress }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open navigation menu"
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.outer,
        pressed && styles.outerPressed,
        glow(palette.cyanGlow, 10) as object,
      ]}
    >
      <View style={styles.bar} />
      <View style={styles.bar} />
      <View style={styles.bar} />
    </Pressable>
  );
}

const BAR_WIDTH = 18;

const styles = StyleSheet.create({
  outer: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(8, 11, 22, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  outerPressed: {
    backgroundColor: "rgba(92, 246, 255, 0.10)",
    borderColor: palette.borderStrong,
  },
  bar: {
    width: BAR_WIDTH,
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.cyan,
  },
});
