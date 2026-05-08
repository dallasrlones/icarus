import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { fonts, glow, hudGrid, palette, radii, space } from "../theme";
import {
  changePassword,
  login,
  type AuthUser,
} from "../auth";

/**
 * Pre-app auth shell. Two visual states share the same chrome —
 * a sci-fi sign-in card sitting on the HUD grid background — so the
 * forced-password-change handoff feels like a continuation rather
 * than a hard route change.
 */
type Mode =
  | { kind: "login" }
  | { kind: "change"; user: AuthUser; forced: boolean; onCancel?: () => void };

interface AuthScreenProps {
  mode: Mode;
  onAuthChanged: (user: AuthUser | null) => void;
}

export function AuthScreen({ mode, onAuthChanged }: AuthScreenProps) {
  if (mode.kind === "login") {
    return (
      <Shell title="ICARUS" subtitle="Authenticate to continue.">
        <LoginForm onAuthChanged={onAuthChanged} />
      </Shell>
    );
  }
  return (
    <Shell
      title="UPDATE CREDENTIALS"
      subtitle={
        mode.forced
          ? "First sign-in detected. Choose a new password before proceeding."
          : "Enter your current password and pick a new one."
      }
    >
      <ChangePasswordForm
        forced={mode.forced}
        onAuthChanged={onAuthChanged}
        onCancel={mode.onCancel}
      />
    </Shell>
  );
}

function Shell(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <View style={styles.root}>
      <View style={styles.grid} pointerEvents="none" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.brandTag}>
            <View style={styles.brandDot} />
            <Text style={styles.brandKind}>SECURE SHELL</Text>
          </View>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.subtitle}>{props.subtitle}</Text>
        </View>
        {props.children}
      </View>
    </View>
  );
}

function LoginForm(props: { onAuthChanged: (u: AuthUser | null) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      props.onAuthChanged(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <Field
        label="USERNAME"
        value={username}
        onChange={setUsername}
        autoComplete="username"
      />
      <Field
        label="PASSWORD"
        value={password}
        onChange={setPassword}
        secure
        autoComplete="current-password"
        onSubmitEditing={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={({ pressed }) => [
          styles.cta,
          pressed ? styles.ctaPress : null,
          busy ? styles.ctaDisabled : null,
        ]}
        onPress={submit}
        disabled={busy}
      >
        <Text style={styles.ctaText}>{busy ? "AUTHENTICATING…" : "SIGN IN"}</Text>
      </Pressable>
      <Text style={styles.hint}>
        Default credentials on first boot are <Text style={styles.hintMono}>admin</Text>{" / "}
        <Text style={styles.hintMono}>changeme</Text>. You'll be required to update them.
      </Text>
    </View>
  );
}

function ChangePasswordForm(props: {
  forced: boolean;
  onAuthChanged: (u: AuthUser | null) => void;
  onCancel?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (next.length < 8) {
      setError("password must be at least 8 characters");
      return;
    }
    if (next !== confirm) {
      setError("new passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const user = await changePassword(current, next);
      props.onAuthChanged(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "password change failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <Field
        label="CURRENT PASSWORD"
        value={current}
        onChange={setCurrent}
        secure
        autoComplete="current-password"
      />
      <Field
        label="NEW PASSWORD"
        value={next}
        onChange={setNext}
        secure
        autoComplete="new-password"
      />
      <Field
        label="CONFIRM NEW PASSWORD"
        value={confirm}
        onChange={setConfirm}
        secure
        autoComplete="new-password"
        onSubmitEditing={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={({ pressed }) => [
          styles.cta,
          pressed ? styles.ctaPress : null,
          busy ? styles.ctaDisabled : null,
        ]}
        onPress={submit}
        disabled={busy}
      >
        <Text style={styles.ctaText}>{busy ? "UPDATING…" : "UPDATE PASSWORD"}</Text>
      </Pressable>
      {!props.forced && props.onCancel ? (
        <Pressable onPress={props.onCancel} style={styles.cancelLink}>
          <Text style={styles.cancelText}>cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
  autoComplete?: string;
  onSubmitEditing?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  // RN's TextInput on web doesn't strictly type these autoComplete tokens,
  // so we widen with `as never` to keep the prop while letting the browser
  // pass them through to the underlying <input>.
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        style={[styles.input, focused ? styles.inputFocus : null]}
        value={props.value}
        onChangeText={props.onChange}
        secureTextEntry={!!props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={props.onSubmitEditing}
        placeholderTextColor={palette.textMuted}
        autoComplete={(props.autoComplete ?? "off") as never}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bgDeep,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  grid: {
    ...StyleSheet.absoluteFillObject,
    ...(Platform.OS === "web" ? hudGrid : {}),
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: palette.bgRaised,
    borderColor: palette.borderHair,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: space.xl,
    ...glow(palette.cyanGlow, 32),
  },
  cardHeader: {
    marginBottom: space.lg,
  },
  brandTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.sm,
  },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.cyan,
    ...glow(palette.cyanGlow, 8),
  },
  brandKind: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
  },
  title: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  subtitle: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 14,
    marginTop: space.xs,
    lineHeight: 20,
  },
  form: {
    gap: space.md,
  },
  field: {
    gap: space.xs,
  },
  fieldLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
  },
  input: {
    backgroundColor: palette.bgBase,
    borderColor: palette.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 15,
  },
  inputFocus: {
    borderColor: palette.cyanDim,
    ...glow(palette.cyanGlow, 12),
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 12,
    marginTop: -space.xs,
  },
  cta: {
    backgroundColor: palette.cyan,
    borderRadius: radii.md,
    paddingVertical: space.md,
    alignItems: "center",
    marginTop: space.sm,
  },
  ctaHover: {
    ...glow(palette.cyanGlow, 16),
  },
  ctaPress: {
    opacity: 0.85,
  },
  ctaDisabled: {
    opacity: 0.6,
  },
  ctaText: {
    color: palette.textInverse,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1.6,
  },
  hint: {
    color: palette.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
    marginTop: space.sm,
    textAlign: "center",
    lineHeight: 18,
  },
  hintMono: {
    fontFamily: fonts.mono,
    color: palette.textSecondary,
  },
  cancelLink: {
    alignItems: "center",
    paddingVertical: space.sm,
  },
  cancelText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1.4,
  },
});

export default AuthScreen;
