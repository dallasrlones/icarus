import { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { fonts, glow, palette, radii, space } from "../theme";
import { useCompactLayout } from "../layout/compact";

type WorkspaceMode = "auto" | "existing" | "none";

export interface NewProjectInput {
  name: string;
  description?: string;
  workspace_path?: string | "auto" | null;
}

interface Props {
  visible: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: NewProjectInput) => void;
}

const MODES: { id: WorkspaceMode; label: string; sub: string }[] = [
  {
    id: "auto",
    label: "auto-create",
    sub: "Server creates a new folder under WORKSPACE_DIR matching the project slug.",
  },
  {
    id: "existing",
    label: "existing path",
    sub: "Point at a folder already on disk (relative to /workspace inside the container).",
  },
  {
    id: "none",
    label: "planning-only",
    sub: "No workspace yet. The agent can plan, design flows, and tasks; it just won't have code to look at.",
  },
];

export function NewProjectModal({ visible, busy, onCancel, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("auto");
  const [path, setPath] = useState("");
  const compact = useCompactLayout();

  const reset = () => {
    setName("");
    setDescription("");
    setMode("auto");
    setPath("");
  };

  const submit = () => {
    if (!name.trim()) return;
    let workspace_path: NewProjectInput["workspace_path"] | undefined;
    if (mode === "auto") workspace_path = "auto";
    else if (mode === "existing") workspace_path = path.trim() || undefined;
    else workspace_path = null;
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      workspace_path,
    });
  };

  const close = () => {
    reset();
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={[styles.scrim, compact && styles.scrimCompact]}>
        <View style={[styles.dialog, compact && styles.dialogCompact]}>
          <View style={styles.head}>
            <Text style={styles.kicker}>// NEW PROJECT</Text>
            <Text style={styles.title}>Initialize project</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Customer Portal"
              placeholderTextColor={palette.textMuted}
              style={styles.input}
              editable={!busy}
              autoFocus
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>DESCRIPTION (optional)</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="One-line summary of what this project is for."
              placeholderTextColor={palette.textMuted}
              style={[styles.input, styles.inputMulti]}
              editable={!busy}
              multiline
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>WORKSPACE</Text>
            <View style={styles.modes}>
              {MODES.map((m) => {
                const active = m.id === mode;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => setMode(m.id)}
                    style={[styles.mode, active && styles.modeActive]}
                  >
                    <View style={[styles.radio, active && styles.radioActive]}>
                      {active ? <View style={styles.radioDot} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>
                        {m.label}
                      </Text>
                      <Text style={styles.modeSub}>{m.sub}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {mode === "existing" && (
              <TextInput
                value={path}
                onChangeText={setPath}
                placeholder="/workspace/some-existing-repo"
                placeholderTextColor={palette.textMuted}
                style={[styles.input, { marginTop: space.sm }]}
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={close}
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
            >
              <Text style={styles.btnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={busy || !name.trim() || (mode === "existing" && !path.trim())}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                (busy || !name.trim() || (mode === "existing" && !path.trim())) && styles.btnDisabled,
                pressed && styles.btnPrimaryPressed,
              ]}
            >
              <Text style={styles.btnPrimaryText}>
                {busy ? "CREATING…" : "CREATE PROJECT"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(5, 7, 13, 0.78)",
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    ...(Platform.OS === "web" ? { backdropFilter: "blur(6px)" as unknown as undefined } : {}),
  },
  scrimCompact: {
    padding: space.sm,
    alignItems: "stretch",
  },
  dialog: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "rgba(15, 22, 38, 0.96)",
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    padding: space.xl,
    gap: space.lg,
    ...glow("rgba(92, 246, 255, 0.18)", 32),
  },
  dialogCompact: {
    padding: space.md,
    gap: space.md,
    borderRadius: radii.md,
    alignSelf: "center",
    maxWidth: "100%",
  },
  head: { gap: 4 },
  kicker: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.4,
  },
  title: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 0.2,
  },

  field: { gap: 6 },
  label: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
  },
  input: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    backgroundColor: "rgba(8, 11, 22, 0.85)",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    paddingHorizontal: 12,
    paddingVertical: 10,
    outlineStyle: "none" as unknown as undefined,
  },
  inputMulti: { minHeight: 64 },

  modes: { gap: 6 },
  mode: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(8, 11, 22, 0.5)",
  },
  modeActive: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92, 246, 255, 0.05)",
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: palette.textMuted,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  radioActive: { borderColor: palette.cyan },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.cyan,
  },
  modeLabel: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 0.8,
    fontWeight: "600",
  },
  modeLabelActive: { color: palette.cyan },
  modeSub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },

  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  btn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
  },
  btnPressed: { backgroundColor: "rgba(120, 220, 255, 0.06)" },
  btnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  btnPrimary: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92, 246, 255, 0.10)",
    ...glow(palette.cyanGlow, 16),
  },
  btnPrimaryPressed: { backgroundColor: "rgba(92, 246, 255, 0.20)" },
  btnPrimaryText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  btnDisabled: { opacity: 0.4 },
});
