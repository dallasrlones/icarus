import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Persona, ResolvedPersona } from "../types";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 14 — Council Personas panel.
 *
 * Used twice: on the global cockpit ("Personas" tab) for fleet-wide
 * personas, and inside ProjectDetail ("Personas" tab) for project-
 * scoped overrides/additions. Same component, same styling, same
 * editor modal — only the `scope` prop changes.
 *
 * Two-section layout:
 *   1. **Resolved panel preview** at the top — what the council
 *      will actually run for this scope, in order, with a provenance
 *      pill per slot ("default" / "global" / "project") so the user
 *      can see at a glance where each lens came from.
 *   2. **Owned personas** list — only the personas authored at this
 *      scope (so the global tab doesn't show project entries and
 *      vice versa). Edit / archive lives here.
 *
 * The "+ NEW PERSONA" button creates an entry at the current scope.
 * Picking a `key` that matches a default replaces that lens; any
 * other `key` adds a new lens to the panel.
 */

export type PersonaScope = { kind: "global" } | { kind: "project"; slug: string };

const ACCENT_OPTIONS: Array<Persona["accent"]> = [
  "cyan",
  "violet",
  "amber",
  "green",
  "rose",
];

const DEFAULT_KEYS: ReadonlyArray<string> = [
  "product",
  "ux",
  "architecture",
  "security",
  "operability",
];

interface Props {
  /** All personas authored at this scope (active only). */
  personas: Persona[];
  /** Resolved lens panel for this scope (all sources merged). */
  resolved: ResolvedPersona[];
  scope: PersonaScope;
  onApply: (envelope: unknown) => Promise<boolean>;
}

export function PersonasPanel({ personas, resolved, scope, onApply }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);

  const owned = useMemo(
    () => [...personas].sort((a, b) => b.updated_at - a.updated_at),
    [personas],
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerLabel}>// council personas</Text>
          <Text style={styles.headerTitle}>
            {scope.kind === "global" ? "Fleet-wide personas" : "Project personas"}
          </Text>
          <Text style={styles.headerSub}>
            {scope.kind === "global"
              ? "Customize the council's review lenses for every project. Match a default key (product, ux, architecture, security, operability) to replace; use a new key (e.g. marketing) to add a lens."
              : "Project-scoped overrides and additions. Stack on top of global personas; replace any lens by matching its key, or add a new one for this project only."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setCreateOpen(true)}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
        >
          <Text style={styles.primaryBtnText}>+ NEW PERSONA</Text>
        </Pressable>
      </View>

      <ResolvedPanel resolved={resolved} scope={scope} />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>// owned at this scope</Text>
        {owned.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No personas at this scope yet.</Text>
            <Text style={styles.emptySub}>
              The resolved panel above is using
              {scope.kind === "global"
                ? " the bundled defaults."
                : " globals + bundled defaults."}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {owned.map((p) => (
              <PersonaRow
                key={p.id}
                persona={p}
                onEdit={() => setEditing(p)}
                onArchive={() =>
                  void onApply({
                    kind: "archive_persona",
                    payload: {
                      persona_id: p.id,
                      scope:
                        scope.kind === "global"
                          ? { kind: "global" }
                          : { kind: "project", project_slug: scope.slug },
                    },
                  })
                }
              />
            ))}
          </View>
        )}
      </View>

      <PersonaEditorModal
        visible={createOpen}
        title="NEW PERSONA"
        initial={null}
        onCancel={() => setCreateOpen(false)}
        onSubmit={async (draft) => {
          const ok = await onApply({
            kind: "create_persona",
            payload: {
              scope:
                scope.kind === "global"
                  ? { kind: "global" }
                  : { kind: "project", project_slug: scope.slug },
              key: draft.key,
              name: draft.name,
              description: draft.description || undefined,
              prompt_template: draft.prompt_template,
              accent: draft.accent,
            },
          });
          if (ok) setCreateOpen(false);
        }}
      />

      <PersonaEditorModal
        visible={!!editing}
        title={editing ? `EDIT ${editing.name.toUpperCase()}` : ""}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSubmit={async (draft) => {
          if (!editing) return;
          const ok = await onApply({
            kind: "update_persona",
            payload: {
              persona_id: editing.id,
              scope:
                scope.kind === "global"
                  ? { kind: "global" }
                  : { kind: "project", project_slug: scope.slug },
              key: draft.key,
              name: draft.name,
              description: draft.description || undefined,
              prompt_template: draft.prompt_template,
              accent: draft.accent,
            },
          });
          if (ok) setEditing(null);
        }}
      />
    </ScrollView>
  );
}

// ---- Resolved panel (provenance preview) ----

function ResolvedPanel({
  resolved,
  scope,
}: {
  resolved: ResolvedPersona[];
  scope: PersonaScope;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>// resolved lens panel</Text>
      <Text style={styles.sectionSub}>
        {scope.kind === "global"
          ? `${resolved.length} lens${resolved.length === 1 ? "" : "es"} — what the council runs by default for any project.`
          : `${resolved.length} lens${resolved.length === 1 ? "" : "es"} — what the council runs for this project. Project entries beat global entries beat defaults on the same key.`}
      </Text>
      <View style={styles.resolvedGrid}>
        {resolved.map((r) => (
          <ResolvedCard key={r.key} resolved={r} />
        ))}
      </View>
    </View>
  );
}

function ResolvedCard({ resolved }: { resolved: ResolvedPersona }) {
  const accentColor = accentToHex(resolved.accent);
  const sourceTone = sourceLabelTone(resolved.source);
  return (
    <View style={[styles.resolvedCard, { borderColor: accentColor }]}>
      <View style={styles.resolvedHeader}>
        <Text style={styles.resolvedKey}>{resolved.key}</Text>
        <View style={[styles.sourcePill, { borderColor: sourceTone, backgroundColor: sourceTone + "22" }]}>
          <Text style={[styles.sourcePillText, { color: sourceTone }]}>
            {resolved.source.toUpperCase()}
          </Text>
        </View>
      </View>
      <Text style={[styles.resolvedName, { color: accentColor }]}>{resolved.name}</Text>
      {resolved.description ? (
        <Text style={styles.resolvedDesc} numberOfLines={3}>
          {resolved.description}
        </Text>
      ) : null}
    </View>
  );
}

// ---- Owned-persona row ----

function PersonaRow({
  persona,
  onEdit,
  onArchive,
}: {
  persona: Persona;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const replaces = DEFAULT_KEYS.includes(persona.key);
  const accentColor = accentToHex(persona.accent);
  return (
    <View style={[styles.row, { borderColor: accentColor }]}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowKey}>{persona.key}</Text>
          {replaces ? (
            <View style={styles.replacesPill}>
              <Text style={styles.replacesPillText}>REPLACES DEFAULT</Text>
            </View>
          ) : (
            <View style={styles.addsPill}>
              <Text style={styles.addsPillText}>NEW LENS</Text>
            </View>
          )}
        </View>
        <Text style={[styles.rowName, { color: accentColor }]}>{persona.name}</Text>
        {persona.description ? (
          <Text style={styles.rowDesc} numberOfLines={2}>
            {persona.description}
          </Text>
        ) : null}
        <Text style={styles.rowPreview} numberOfLines={3}>
          {persona.prompt_template}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onEdit}
          style={({ pressed }) => [styles.smallBtn, pressed && styles.smallBtnPressed]}
        >
          <Text style={styles.smallBtnText}>EDIT</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onArchive}
          style={({ pressed }) => [styles.smallBtn, pressed && styles.smallBtnPressed]}
        >
          <Text style={[styles.smallBtnText, { color: palette.danger }]}>ARCHIVE</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Editor modal ----

interface DraftPersona {
  key: string;
  name: string;
  description: string;
  prompt_template: string;
  accent?: Persona["accent"];
}

function blankDraft(): DraftPersona {
  return {
    key: "",
    name: "",
    description: "",
    prompt_template: "",
    accent: undefined,
  };
}

function personaToDraft(p: Persona): DraftPersona {
  return {
    key: p.key,
    name: p.name,
    description: p.description ?? "",
    prompt_template: p.prompt_template,
    accent: p.accent,
  };
}

function PersonaEditorModal({
  visible,
  title,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  initial: Persona | null;
  onCancel: () => void;
  onSubmit: (draft: DraftPersona) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftPersona>(blankDraft());

  useMemo(() => {
    setDraft(initial ? personaToDraft(initial) : blankDraft());
  }, [initial, visible]);

  const isDefault = DEFAULT_KEYS.includes(draft.key);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Field
              label="KEY"
              value={draft.key}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  key: v
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/^-+|-+$/g, ""),
                }))
              }
              hint={
                isDefault
                  ? "Matches a default lens — this persona will REPLACE that slot in the council panel."
                  : "Free key — this persona will ADD a new lens to the council panel. Defaults: product, ux, architecture, security, operability."
              }
            />
            <Field
              label="NAME"
              value={draft.name}
              onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
              hint="Shown in the council UI as the lens title."
            />
            <Field
              label="DESCRIPTION (optional)"
              value={draft.description}
              onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
              multiline
              minHeight={48}
              hint="One short sentence; surfaces in the resolved panel preview."
            />
            <Field
              label="CHARTER (prompt)"
              value={draft.prompt_template}
              onChange={(v) => setDraft((d) => ({ ...d, prompt_template: v }))}
              multiline
              minHeight={140}
              hint="Pure prose, no Mustache vars. Wrapped by the runner with the standard council framing — write only the lens-specific brief."
            />
            <View style={styles.accentRow}>
              <Text style={styles.fieldLabel}>ACCENT</Text>
              <View style={styles.accentChips}>
                {ACCENT_OPTIONS.map((a) => {
                  const active = draft.accent === a;
                  const color = accentToHex(a);
                  return (
                    <Pressable
                      key={a ?? "none"}
                      onPress={() =>
                        setDraft((d) => ({
                          ...d,
                          accent: active ? undefined : a,
                        }))
                      }
                      style={[
                        styles.accentChip,
                        { borderColor: color },
                        active && { backgroundColor: color + "33" },
                      ]}
                    >
                      <Text style={[styles.accentChipText, { color }]}>{a}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </ScrollView>
          <View style={styles.modalFooter}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
            >
              <Text style={styles.secondaryBtnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={() => void onSubmit(draft)}
              disabled={!draft.key || !draft.name || !draft.prompt_template}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
                (!draft.key || !draft.name || !draft.prompt_template) && styles.primaryBtnDisabled,
              ]}
            >
              <Text style={styles.primaryBtnText}>SAVE</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- Field primitive ----

function Field({
  label,
  value,
  onChange,
  multiline,
  minHeight,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  minHeight?: number;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        style={[
          styles.fieldInput,
          multiline && styles.fieldInputMultiline,
          minHeight ? { minHeight } : null,
        ]}
        placeholderTextColor={palette.textMuted}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

// ---- helpers ----

function accentToHex(a: Persona["accent"] | undefined): string {
  switch (a) {
    case "cyan":
      return palette.cyan;
    case "violet":
      return palette.violet;
    case "amber":
      return palette.amber;
    case "green":
      return palette.green;
    case "rose":
      return palette.rose;
    default:
      return palette.violet;
  }
}

function sourceLabelTone(source: ResolvedPersona["source"]): string {
  switch (source) {
    case "default":
      return palette.textSecondary;
    case "global":
      return palette.cyan;
    case "project":
      return palette.amber;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { padding: space.xl, gap: space.lg },

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.md,
  },
  headerLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  headerTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 2,
  },
  headerSub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 4,
    maxWidth: 540,
  },

  primaryBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92,246,255,0.06)",
    ...glow(palette.cyanGlow, 12),
  },
  primaryBtnPressed: { backgroundColor: "rgba(92,246,255,0.14)" },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  secondaryBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  secondaryBtnPressed: { backgroundColor: "rgba(180,200,220,0.06)" },
  secondaryBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "500",
  },

  section: { gap: space.sm },
  sectionLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  sectionSub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },

  resolvedGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    marginTop: space.xs,
  },
  resolvedCard: {
    width: 220,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: palette.bgPanel,
    padding: space.sm,
    gap: 4,
  },
  resolvedHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  resolvedKey: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  resolvedName: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "700",
  },
  resolvedDesc: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  sourcePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  sourcePillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
  },

  list: { gap: space.sm, marginTop: space.xs },
  empty: {
    padding: space.xl,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  emptySub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    textAlign: "center",
    maxWidth: 380,
  },

  row: {
    flexDirection: "row",
    gap: space.md,
    padding: space.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    backgroundColor: palette.bgPanel,
  },
  rowMain: { flex: 1, gap: 4 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowKey: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  rowName: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "700",
  },
  rowDesc: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  rowPreview: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: "column",
    gap: space.xs,
  },
  replacesPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.amber,
    backgroundColor: "rgba(255,180,84,0.12)",
  },
  replacesPillText: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: "700",
  },
  addsPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.green,
    backgroundColor: "rgba(118,245,176,0.12)",
  },
  addsPillText: {
    color: palette.green,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: "700",
  },

  smallBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  smallBtnPressed: { backgroundColor: "rgba(180,200,220,0.06)" },
  smallBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(5,7,13,0.85)",
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 640,
    maxHeight: "90%",
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.bgRaised,
    ...glow(palette.cyanGlow, 16),
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
  },
  modalTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1.5,
    fontWeight: "700",
  },
  modalClose: {
    color: palette.textMuted,
    fontSize: 24,
    paddingHorizontal: 8,
  },
  modalBody: {
    padding: space.md,
    gap: space.sm,
  },
  modalFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: palette.borderHair,
  },

  field: { gap: 4 },
  fieldLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  fieldInput: {
    backgroundColor: palette.bgBase,
    color: palette.textPrimary,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  fieldInputMultiline: {
    textAlignVertical: "top",
    paddingTop: 8,
  },
  fieldHint: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  accentRow: { gap: 4 },
  accentChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  accentChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  accentChipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: "700",
  },
});
