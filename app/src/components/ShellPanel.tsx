import type { ReactElement } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { ShellTerminal } from "./ShellTerminal";
import { buildShellWsUrl } from "../shellWs";
import { fonts, palette, radii, space } from "../theme";

interface Props {
  scope: "global" | "project";
  /** Required when `scope === "project"`. */
  slug?: string;
  /** Shown as a hint line (host path). */
  cwdHint?: string;
}

/**
 * Authenticated interactive shell: global cockpit starts in server `$HOME`
 * (override with `ICARUS_SHELL_GLOBAL_CWD`); project scope starts in that
 * project's `workspace_path`. Web-only terminal UI.
 */
export function ShellPanel({ scope, slug, cwdHint }: Props): ReactElement {
  const wsUrl =
    Platform.OS === "web" ? buildShellWsUrl(scope, scope === "project" ? slug : undefined) : null;

  const hint =
    scope === "global"
      ? "cwd: server home (~). Set ICARUS_SHELL_GLOBAL_CWD to pin a directory."
      : cwdHint && cwdHint.length > 0
        ? `cwd: ${cwdHint}`
        : slug
          ? `cwd: workspace for “${slug}”`
          : "cwd: project workspace";

  return (
    <View style={styles.outer}>
      <View style={styles.banner}>
        <Text style={styles.kicker}>// SHELL</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      {Platform.OS === "web" && wsUrl ? (
        <ShellTerminal wsUrl={wsUrl} />
      ) : Platform.OS === "web" ? (
        <Text style={styles.warn}>Sign in required — shell uses your JWT.</Text>
      ) : (
        <ShellTerminal />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  banner: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    backgroundColor: palette.bgPanel,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 4,
  },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
    color: palette.cyan,
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: palette.textSecondary,
  },
  warn: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: palette.amber,
    paddingVertical: space.md,
  },
});
