import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  getVoiceSettings,
  setVoiceSettings,
  type VoiceEndpointSettings,
} from "../api";
import { subscribe as subscribeEvents } from "../events";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 20 — Settings panel.
 *
 * Lives on the global cockpit's "Settings" tab. Today it surfaces
 * one knob: per-role cursor-agent model selection (chat vs agent).
 * The shape is intentionally roomy so future runtime toggles
 * (queue auto-start, council aggressiveness, telemetry, etc.) can
 * stack here without a new tab per feature.
 *
 * Updates funnel through the standard mutation envelope
 * (`set_models`) instead of a bespoke PATCH endpoint, so:
 *   - the agent can flip models from chat too,
 *   - the change rides the activity log + WS broadcast pipeline,
 *   - all open tabs (and the agent's own plans) see the new
 *     selection within one event tick.
 *
 * Why dropdowns instead of free-text: model slugs are typo-prone
 * and a wrong slug fails silently with a misleading
 * "spawn cursor-agent ENOENT" — the dropdown both discovers and
 * constrains. The catalog below is hand-curated against cursor's
 * public model lineup; advanced users can still set an arbitrary
 * slug via the `CURSOR_MODEL` env or via chat ("set models to X").
 */

interface ModelOption {
  /** Slug passed to `cursor-agent --model`. Empty string == "(default)". */
  slug: string;
  /** Human-readable label rendered in the dropdown. */
  label: string;
  /** One-liner shown under the label to hint at usage cost / strength. */
  hint: string;
}

const CHAT_MODELS: ModelOption[] = [
  { slug: "composer-2", label: "Composer 2", hint: "Default · fast & cheap" },
  { slug: "composer-2-fast", label: "Composer 2 Fast", hint: "Fastest variant" },
  { slug: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet", hint: "Balanced" },
  { slug: "claude-opus-4.7", label: "Claude Opus 4.7", hint: "Heaviest reasoning" },
  { slug: "gpt-5.5-medium", label: "GPT 5.5", hint: "OpenAI · medium thinking" },
  { slug: "gpt-5.3-codex", label: "GPT 5.3 Codex", hint: "OpenAI · codex" },
  { slug: "auto", label: "Auto", hint: "Let cursor-agent pick" },
];

const AGENT_MODELS: ModelOption[] = [
  { slug: "claude-opus-4.7", label: "Claude Opus 4.7", hint: "Default · heaviest reasoning" },
  { slug: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet", hint: "Balanced" },
  { slug: "composer-2", label: "Composer 2", hint: "Cheap & fast" },
  { slug: "composer-2-fast", label: "Composer 2 Fast", hint: "Fastest variant" },
  { slug: "gpt-5.5-medium", label: "GPT 5.5", hint: "OpenAI · medium thinking" },
  { slug: "gpt-5.3-codex", label: "GPT 5.3 Codex", hint: "OpenAI · codex" },
  { slug: "auto", label: "Auto", hint: "Let cursor-agent pick" },
];

interface Props {
  models: { chat: string; agent: string; loaded: boolean };
  onApply: (envelope: unknown) => Promise<boolean>;
}

export function SettingsPanel({ models, onApply }: Props) {
  const [savingRole, setSavingRole] = useState<"chat" | "agent" | null>(null);

  /**
   * If the persisted slug isn't in our curated catalog (custom
   * env-set slug, or model that's been removed since), surface it
   * as a synthetic "Custom" entry so the user can see what they're
   * on without us silently overwriting it.
   */
  const chatOptions = useMemo(() => withCustom(CHAT_MODELS, models.chat), [models.chat]);
  const agentOptions = useMemo(() => withCustom(AGENT_MODELS, models.agent), [models.agent]);

  async function pick(role: "chat" | "agent", slug: string) {
    setSavingRole(role);
    try {
      await onApply({
        kind: "set_models",
        payload: role === "chat" ? { chat: slug } : { agent: slug },
        client_id: cryptoRandomId(),
      });
    } finally {
      setSavingRole(null);
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Text style={styles.headerEyebrow}>// settings</Text>
        <Text style={styles.headerTitle}>System Configuration</Text>
        <Text style={styles.headerSubtitle}>
          Per-role cursor-agent model selection. Changes take effect on the next turn — no restart needed.
        </Text>
      </View>

      <Section
        eyebrow="// chat model"
        title="Conversational"
        body="Used by the chat composer and the voice spoken-summary. Picking a faster/cheaper model here keeps interactive turns snappy."
      >
        <ModelDropdown
          role="chat"
          current={models.chat}
          loaded={models.loaded}
          options={chatOptions}
          saving={savingRole === "chat"}
          onPick={(slug) => void pick("chat", slug)}
        />
      </Section>

      <Section
        eyebrow="// agent model"
        title="Autonomous"
        body="Used by the queue worker (task execution), council runs, and tool runs. A heavier reasoning model here means better autonomous decisions at the cost of higher per-task spend."
      >
        <ModelDropdown
          role="agent"
          current={models.agent}
          loaded={models.loaded}
          options={agentOptions}
          saving={savingRole === "agent"}
          onPick={(slug) => void pick("agent", slug)}
        />
      </Section>

      <VoiceApiSection />

      <View style={styles.footnote}>
        <Text style={styles.footnoteText}>
          Tip: you can also flip these from chat — say "switch chat to composer 2" or "use opus for agents".
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * Phase 21 — Voice APIs hot-swap form.
 *
 * Lives inside SettingsPanel because the surface is small (4-6
 * fields) and pairs naturally with the model selectors above.
 *
 * State model:
 *   - `loaded` is the canonical server view (URLs, voice, language,
 *     auth status as "***"). We render the form against a local
 *     `draft` so the user can edit without instant network writes.
 *   - Auth fields default to "***" if a token is configured —
 *     submitting with that placeholder leaves the existing token
 *     untouched (the server treats `"***"` as a no-op). To clear,
 *     blank the field and save.
 *   - Save is a single PATCH that replaces every field at once.
 *
 * The eyebrow shows provenance ("env" / "custom" / "unset") so the
 * user can tell whether they're running on the .env defaults vs an
 * override they typed in. The form fields show the *override* (or
 * blank if not set), while small inline hints surface the
 * `effective_*` value the server is actually using.
 */
function VoiceApiSection() {
  const [loaded, setLoaded] = useState<VoiceEndpointSettings | null>(null);
  const [draft, setDraft] = useState<{
    stt_url: string;
    stt_auth: string;
    tts_url: string;
    tts_auth: string;
    voice: string;
    language: string;
  }>({
    stt_url: "",
    stt_auth: "",
    tts_url: "",
    tts_auth: "",
    voice: "",
    language: "",
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const v = await getVoiceSettings();
      setLoaded(v);
      setDraft({
        stt_url: v.stt.url,
        stt_auth: v.stt.auth,
        tts_url: v.tts.url,
        tts_auth: v.tts.auth,
        voice: v.tts.voice,
        language: v.tts.language,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load voice settings");
    }
  }

  useEffect(() => {
    void refresh();
    // Other tabs / agent verbs may flip voice config — re-fetch on
    // the broadcast so the form stays in sync.
    return subscribeEvents((ev) => {
      if (ev.type === "voice_settings_changed") void refresh();
    });
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await setVoiceSettings(draft);
      setLoaded(next);
      // Replace the form's auth fields with the server-echoed
      // status so a previously-set token shows as "***" again
      // (don't echo the cleartext token even if the user just typed it).
      setDraft({
        stt_url: next.stt.url,
        stt_auth: next.stt.auth,
        tts_url: next.tts.url,
        tts_auth: next.tts.auth,
        voice: next.tts.voice,
        language: next.tts.language,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save voice settings");
    } finally {
      setSaving(false);
    }
  }

  function reset(): void {
    setDraft({
      stt_url: "",
      stt_auth: "",
      tts_url: "",
      tts_auth: "",
      voice: "",
      language: "",
    });
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionEyebrow}>// voice apis</Text>
      <Text style={styles.sectionTitle}>Speech-to-Text & Text-to-Speech</Text>
      <Text style={styles.sectionBody}>
        Hot-swap the STT and TTS endpoints icarus calls. Fields below override the matching env var; leave blank to fall back to the env / shipped default. URLs must speak the icarus voice contract — see <Text style={styles.codeInline}>docs/VOICE.md</Text> for the spec or to wrap a third-party provider in a thin proxy.
      </Text>

      <View style={styles.fieldGroup}>
        <FieldHeader
          label="STT URL"
          source={loaded?.stt.source ?? "unset"}
          effective={loaded?.stt.effective_url ?? ""}
        />
        <TextInput
          value={draft.stt_url}
          onChangeText={(stt_url) => setDraft({ ...draft, stt_url })}
          placeholder="http://host:port  (leave blank to use VOICE_STT_URL)"
          placeholderTextColor={palette.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FieldHeader label="STT Auth (optional)" hint="Bearer token" />
        <TextInput
          value={draft.stt_auth}
          onChangeText={(stt_auth) => setDraft({ ...draft, stt_auth })}
          placeholder="(none)"
          placeholderTextColor={palette.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={draft.stt_auth !== "" && draft.stt_auth !== "***"}
        />
      </View>

      <View style={styles.fieldGroup}>
        <FieldHeader
          label="TTS URL"
          source={loaded?.tts.source ?? "unset"}
          effective={loaded?.tts.effective_url ?? ""}
        />
        <TextInput
          value={draft.tts_url}
          onChangeText={(tts_url) => setDraft({ ...draft, tts_url })}
          placeholder="http://host:port  (leave blank to use VOICE_TTS_URL)"
          placeholderTextColor={palette.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FieldHeader label="TTS Auth (optional)" hint="Bearer token" />
        <TextInput
          value={draft.tts_auth}
          onChangeText={(tts_auth) => setDraft({ ...draft, tts_auth })}
          placeholder="(none)"
          placeholderTextColor={palette.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={draft.tts_auth !== "" && draft.tts_auth !== "***"}
        />

        <View style={styles.row2}>
          <View style={styles.col2}>
            <FieldHeader
              label="Voice"
              hint={loaded?.tts.effective_voice ? `live: ${loaded.tts.effective_voice}` : undefined}
            />
            <TextInput
              value={draft.voice}
              onChangeText={(voice) => setDraft({ ...draft, voice })}
              placeholder="default"
              placeholderTextColor={palette.textMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={styles.col2}>
            <FieldHeader
              label="Language"
              hint={loaded?.tts.effective_language ? `live: ${loaded.tts.effective_language}` : undefined}
            />
            <TextInput
              value={draft.language}
              onChangeText={(language) => setDraft({ ...draft, language })}
              placeholder="en"
              placeholderTextColor={palette.textMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => void save()}
          accessibilityRole="button"
          accessibilityLabel="save voice api settings"
          disabled={saving}
          style={[styles.primaryButton, saving && styles.primaryButtonDisabled]}
        >
          <Text style={styles.primaryButtonText}>{saving ? "SAVING…" : "SAVE"}</Text>
        </Pressable>
        <Pressable
          onPress={reset}
          accessibilityRole="button"
          accessibilityLabel="reset voice api fields"
          disabled={saving}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>CLEAR ALL</Text>
        </Pressable>
        {savedAt && Date.now() - savedAt < 4000 ? (
          <Text style={styles.savedNote}>saved · health re-probing</Text>
        ) : null}
      </View>
    </View>
  );
}

interface FieldHeaderProps {
  label: string;
  source?: "settings" | "env" | "unset";
  effective?: string;
  hint?: string;
}

function FieldHeader({ label, source, effective, hint }: FieldHeaderProps) {
  const sourceLabel =
    source === "settings"
      ? "custom"
      : source === "env"
        ? "env"
        : source === "unset"
          ? "unset"
          : null;
  return (
    <View style={styles.fieldHeader}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {sourceLabel ? (
        <View style={[styles.sourceBadge, source === "unset" && styles.sourceBadgeUnset]}>
          <Text style={styles.sourceBadgeText}>{sourceLabel}</Text>
        </View>
      ) : null}
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      {effective && source !== "unset" ? (
        <Text style={styles.fieldHint} numberOfLines={1}>
          live: {effective}
        </Text>
      ) : null}
    </View>
  );
}

interface SectionProps {
  eyebrow: string;
  title: string;
  body: string;
  children: React.ReactNode;
}

function Section({ eyebrow, title, body, children }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{body}</Text>
      {children}
    </View>
  );
}

interface DropdownProps {
  role: "chat" | "agent";
  current: string;
  loaded: boolean;
  options: ModelOption[];
  saving: boolean;
  onPick: (slug: string) => void;
}

function ModelDropdown({ role, current, loaded, options, saving, onPick }: DropdownProps) {
  return (
    <View style={styles.dropdown}>
      {!loaded ? (
        <Text style={styles.loadingRow}>loading…</Text>
      ) : (
        options.map((opt) => {
          const active = opt.slug === current;
          return (
            <Pressable
              key={opt.slug}
              onPress={() => !saving && !active && onPick(opt.slug)}
              accessibilityRole="button"
              accessibilityLabel={`${role} model: ${opt.label}`}
              style={[styles.row, active && styles.rowActive]}
            >
              <View style={styles.rowMain}>
                <View style={[styles.radio, active && styles.radioActive]}>
                  {active ? <View style={styles.radioDot} /> : null}
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{opt.label}</Text>
                  <Text style={styles.rowHint}>{opt.hint}</Text>
                </View>
              </View>
              <Text style={styles.rowSlug}>{opt.slug || "(default)"}</Text>
            </Pressable>
          );
        })
      )}
      {saving ? <Text style={styles.savingNote}>saving…</Text> : null}
    </View>
  );
}

/**
 * If `current` isn't in the catalog, prepend a "Custom" entry that
 * preserves the user's actual slug. Keeps env-driven custom slugs
 * visible instead of silently rendering as "no selection".
 */
function withCustom(catalog: ModelOption[], current: string): ModelOption[] {
  if (!current || catalog.some((o) => o.slug === current)) return catalog;
  return [
    { slug: current, label: "Custom", hint: "Set via CURSOR_MODEL or chat" },
    ...catalog,
  ];
}

/** Best-effort UUID-ish for envelope client_id — falls back if Web Crypto unavailable. */
function cryptoRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: space.lg,
    paddingBottom: space.xxl,
  },
  header: {
    marginBottom: space.lg,
  },
  headerEyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.cyanDim,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  headerTitle: {
    fontFamily: fonts.body,
    fontSize: 22,
    fontWeight: "700",
    color: palette.textPrimary,
    marginBottom: space.xs,
  },
  headerSubtitle: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: palette.textSecondary,
    lineHeight: 19,
  },
  section: {
    backgroundColor: palette.bgPanel,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderHair,
    padding: space.lg,
    marginBottom: space.lg,
  },
  sectionEyebrow: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.cyanDim,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  sectionTitle: {
    fontFamily: fonts.body,
    fontSize: 16,
    fontWeight: "600",
    color: palette.textPrimary,
    marginBottom: space.xs,
  },
  sectionBody: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: palette.textSecondary,
    lineHeight: 18,
    marginBottom: space.md,
  },
  dropdown: {
    gap: space.xs,
  },
  loadingRow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.textMuted,
    paddingVertical: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(13, 19, 34, 0.4)",
  },
  rowActive: {
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92, 246, 255, 0.05)",
    ...glow(palette.cyanGlow, 8),
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },
  radio: {
    width: 14,
    height: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    marginRight: space.md,
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: {
    borderColor: palette.cyan,
  },
  radioDot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: palette.cyan,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: "500",
    color: palette.textPrimary,
  },
  rowLabelActive: {
    color: palette.cyan,
  },
  rowHint: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: palette.textSecondary,
    marginTop: 1,
  },
  rowSlug: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.textMuted,
    marginLeft: space.md,
  },
  savingNote: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.cyanDim,
    marginTop: space.xs,
  },
  footnote: {
    paddingHorizontal: space.sm,
    marginTop: space.sm,
  },
  footnoteText: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: palette.textMuted,
    fontStyle: "italic",
    lineHeight: 16,
  },
  codeInline: {
    fontFamily: fonts.mono,
    color: palette.cyanDim,
  },
  fieldGroup: {
    marginTop: space.sm,
    gap: space.xs,
  },
  fieldHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.sm,
    flexWrap: "wrap",
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  fieldHint: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.textMuted,
  },
  sourceBadge: {
    backgroundColor: "rgba(92, 246, 255, 0.08)",
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  sourceBadgeUnset: {
    backgroundColor: "rgba(255, 107, 107, 0.06)",
    borderColor: "rgba(255, 107, 107, 0.2)",
  },
  sourceBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: palette.cyanDim,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  input: {
    backgroundColor: "rgba(13, 19, 34, 0.6)",
    borderWidth: 1,
    borderColor: palette.borderSoft,
    borderRadius: radii.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontFamily: fonts.mono,
    fontSize: 12,
    color: palette.textPrimary,
  },
  row2: {
    flexDirection: "row",
    gap: space.md,
    marginTop: space.xs,
  },
  col2: {
    flex: 1,
    minWidth: 0,
  },
  errorText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.danger,
    marginTop: space.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.md,
    flexWrap: "wrap",
  },
  primaryButton: {
    backgroundColor: "rgba(92, 246, 255, 0.12)",
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radii.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    ...glow(palette.cyanGlow, 8),
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.cyan,
    letterSpacing: 1.2,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  secondaryButtonText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.textSecondary,
    letterSpacing: 1.2,
  },
  savedNote: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: palette.cyanDim,
  },
});
