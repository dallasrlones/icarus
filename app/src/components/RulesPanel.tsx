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
import type { Rule } from "../types";
import { useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 12 — Rules panel.
 *
 * Used twice: once on the global cockpit ("Rules" tab) for fleet-wide
 * rules, once inside ProjectDetail ("Rules" tab) for project-scoped
 * rules. Same component, same styling, same modal — only the `scope`
 * prop changes.
 *
 * UX choices:
 *   - Single-list view; archived rules are filtered out at the API
 *     unless the user toggles "Show archived" (kept as a future
 *     enhancement — for now the underlying data already filters).
 *   - Inline enable/disable toggle on every row so users can mute
 *     experiments without losing the body.
 *   - Body preview is truncated to ~3 lines with a fade-out — full
 *     body lives in the editor modal.
 *   - "Scope" hint pill on each row makes mixing global/project rules
 *     in the same render unambiguous (only used for project-only
 *     editor would need to disable scope picking; currently the
 *     panel has a fixed scope so the UI is straightforward).
 */

export type RuleScope = { kind: "global" } | { kind: "project"; slug: string };

interface Props {
  rules: Rule[];
  scope: RuleScope;
  onApply: (envelope: unknown) => Promise<boolean>;
}

export function RulesPanel({ rules, scope, onApply }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);

  const sorted = useMemo(
    () =>
      [...rules].sort((a, b) => {
        // enabled first, then most recently updated
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return b.updated_at - a.updated_at;
      }),
    [rules],
  );

  const scopeLabel = scope.kind === "global" ? "GLOBAL" : `PROJECT · ${scope.slug.toUpperCase()}`;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerLabel}>// rules</Text>
          <Text style={styles.headerTitle}>
            {scope.kind === "global" ? "Fleet-wide rules" : "Project rules"}
          </Text>
          <Text style={styles.headerSub}>
            {scope.kind === "global"
              ? "Free-form guidance prepended to every cursor-agent run across all projects — chat, queue, council, tools."
              : "Free-form guidance applied only when this project is the active scope. Stacks on top of any global rules."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setCreateOpen(true)}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
        >
          <Text style={styles.primaryBtnText}>+ NEW RULE</Text>
        </Pressable>
      </View>

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No {scope.kind === "global" ? "global" : "project"} rules.</Text>
          <Text style={styles.emptySub}>
            Rules are short markdown bodies the agent reads before doing
            anything. Author them once and the fleet picks them up
            automatically. Try things like "always use TypeScript strict
            mode" or "favor composition over inheritance".
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.scopePillRow}>
            <Text style={styles.scopePill}>{scopeLabel}</Text>
            <Text style={styles.scopeHint}>
              {sorted.filter((r) => r.enabled).length} enabled · {sorted.length} total
            </Text>
          </View>
          {sorted.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onEdit={() => setEditing(rule)}
              onToggle={() =>
                void onApply({
                  kind: "set_rule_enabled",
                  payload: { rule_id: rule.id, enabled: !rule.enabled, scope: scopePayload(scope) },
                })
              }
              onArchive={() =>
                void onApply({
                  kind: "archive_rule",
                  payload: { rule_id: rule.id, scope: scopePayload(scope) },
                })
              }
            />
          ))}
        </ScrollView>
      )}

      <RuleEditorModal
        visible={createOpen}
        title="NEW RULE"
        initial={null}
        onCancel={() => setCreateOpen(false)}
        onSubmit={async (draft) => {
          const ok = await onApply({
            kind: "create_rule",
            payload: { ...draft, scope: scopePayload(scope) },
          });
          if (ok) setCreateOpen(false);
        }}
      />

      <RuleEditorModal
        visible={!!editing}
        title={editing ? `EDIT ${editing.title.toUpperCase()}` : ""}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSubmit={async (draft) => {
          if (!editing) return;
          const ok = await onApply({
            kind: "update_rule",
            payload: {
              rule_id: editing.id,
              scope: scopePayload(scope),
              ...draft,
            },
          });
          if (ok) setEditing(null);
        }}
      />
    </View>
  );
}

function scopePayload(
  scope: RuleScope,
): { kind: "global" } | { kind: "project"; project_slug: string } {
  return scope.kind === "global"
    ? { kind: "global" }
    : { kind: "project", project_slug: scope.slug };
}

function RuleRow({
  rule,
  onEdit,
  onToggle,
  onArchive,
}: {
  rule: Rule;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
}) {
  const previewLines = rule.body.split("\n");
  const preview = previewLines.slice(0, 3).join("\n");
  return (
    <View style={[styles.row, !rule.enabled && styles.rowMuted]}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{rule.title}</Text>
          {rule.category ? <Text style={styles.rowCategory}>{rule.category}</Text> : null}
          {!rule.enabled ? <Text style={styles.disabledBadge}>DISABLED</Text> : null}
        </View>
        <Text style={styles.rowPreview} numberOfLines={3}>
          {preview}
          {previewLines.length > 3 ? "\n…" : ""}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onToggle}
          style={({ pressed }) => [
            styles.actionBtn,
            rule.enabled && styles.actionBtnEnabled,
            pressed && styles.actionBtnPressed,
          ]}
        >
          <Text
            style={[
              styles.actionBtnText,
              rule.enabled && styles.actionBtnTextEnabled,
            ]}
          >
            {rule.enabled ? "ON" : "OFF"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onEdit}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={styles.actionBtnText}>EDIT</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onArchive}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>ARCHIVE</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface DraftRule {
  title: string;
  body: string;
  category?: string;
  enabled?: boolean;
}

function RuleEditorModal({
  visible,
  title,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  initial: Rule | null;
  onCancel: () => void;
  onSubmit: (draft: DraftRule) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftRule>(blankDraft());

  useMemo(() => {
    setDraft(initial ? ruleToDraft(initial) : blankDraft());
  }, [initial, visible]);

  const compact = useCompactLayout();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.modalBackdrop, compact && compactModalBackdrop]}>
        <View style={[styles.modalCard, compact && compactModalCard]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <Text style={styles.modalClose}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Field
              label="TITLE"
              value={draft.title}
              onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
            />
            <Field
              label="CATEGORY (optional)"
              value={draft.category ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
              hint='Free-form tag for grouping ("style", "safety", "workflow"…).'
            />
            <Field
              label="BODY"
              value={draft.body}
              onChange={(v) => setDraft((d) => ({ ...d, body: v }))}
              multiline
              minHeight={180}
              hint="Markdown ok. Prepended to every cursor-agent run in this scope."
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => setDraft((d) => ({ ...d, enabled: !(d.enabled ?? true) }))}
              style={[
                styles.toggleRow,
                (draft.enabled ?? true) && styles.toggleRowOn,
              ]}
            >
              <Text style={styles.toggleText}>
                {(draft.enabled ?? true) ? "ENABLED ✓" : "DISABLED"}
              </Text>
              <Text style={styles.toggleSub}>
                Disabled rules stay in the registry but skip injection.
              </Text>
            </Pressable>
          </ScrollView>
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
            >
              <Text style={styles.secondaryBtnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const cleaned: DraftRule = { ...draft };
                if (!cleaned.category) delete cleaned.category;
                void onSubmit(cleaned);
              }}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
            >
              <Text style={styles.primaryBtnText}>{initial ? "SAVE" : "CREATE"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function blankDraft(): DraftRule {
  return { title: "", body: "", category: "", enabled: true };
}

function ruleToDraft(r: Rule): DraftRule {
  return {
    title: r.title,
    body: r.body,
    category: r.category ?? "",
    enabled: r.enabled,
  };
}

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
        multiline={!!multiline}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          minHeight ? { minHeight } : null,
        ]}
        placeholderTextColor={palette.textMuted}
      />
      {hint ? <Text style={styles.helperSmall}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: space.xl, gap: space.lg },

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
    maxWidth: 480,
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

  empty: { padding: space.xl, alignItems: "center", gap: 8 },
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

  list: { gap: space.md, paddingBottom: space.xl },

  scopePillRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  scopePill: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radii.sm,
  },
  scopeHint: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  row: {
    flexDirection: "row",
    gap: space.md,
    padding: space.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: palette.bgPanel,
  },
  rowMuted: { opacity: 0.55 },
  rowMain: { flex: 1, gap: 6 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  rowTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  rowCategory: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: palette.violetDim,
    borderRadius: radii.sm,
  },
  disabledBadge: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    borderRadius: radii.sm,
  },
  rowPreview: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.18)",
    padding: 8,
    borderRadius: radii.sm,
  },

  rowActions: { flexDirection: "column", gap: 6, alignItems: "flex-end" },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    minWidth: 64,
    alignItems: "center",
  },
  actionBtnEnabled: {
    borderColor: palette.cyanGlow,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  actionBtnPressed: { backgroundColor: "rgba(180,200,220,0.06)" },
  actionBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "500",
  },
  actionBtnTextEnabled: { color: palette.cyan },
  actionBtnTextDanger: { color: palette.danger },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: space.xl,
  },
  modalCard: {
    width: "100%",
    maxWidth: 720,
    maxHeight: "92%",
    borderRadius: radii.lg,
    backgroundColor: palette.bgPanel,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSoft,
  },
  modalTitle: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1.5,
    fontWeight: "700",
  },
  modalClose: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 22,
    paddingHorizontal: 8,
  },
  modalBody: { padding: space.md, gap: space.md },
  modalFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: palette.borderSoft,
  },

  field: { gap: 6 },
  fieldLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  input: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 13,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  inputMultiline: {
    paddingTop: 10,
    textAlignVertical: "top",
  },
  helperSmall: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  toggleRow: {
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    gap: 4,
  },
  toggleRowOn: {
    borderColor: palette.cyanGlow,
    backgroundColor: "rgba(92,246,255,0.06)",
  },
  toggleText: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  toggleSub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
});
