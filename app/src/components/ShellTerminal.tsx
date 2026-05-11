import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { fonts, palette, space } from "../theme";

/** Native stub — web uses `ShellTerminal.web.tsx` (see also `shellWs.ts`). */
export function ShellTerminal(_props?: { wsUrl?: string }): ReactElement | null {
  return (
    <View style={{ padding: space.lg }}>
      <Text style={{ fontFamily: fonts.body, color: palette.textMuted }}>
        Interactive shell is available in the web app only.
      </Text>
    </View>
  );
}
