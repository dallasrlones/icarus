import { useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  Architecture,
  ArchService,
  ServiceKind,
} from "../types";
import { SERVICE_KINDS } from "../types";
import { useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Phase 8 architecture canvas. Renders a project's service map (boxes
 * for services, arrows for edges) with click-ops for create/delete.
 *
 * Mobile-first: a vertical list of services on the left and a panel
 * showing the currently-selected service's edges on the right. The
 * full graph view (positioned boxes + connecting lines) renders on
 * web via an SVG overlay; on native we just show the list.
 *
 * Keeping the interactions simple in v1:
 *   - Tap a service to inspect its outgoing/incoming edges
 *   - "+ ADD SERVICE" opens a modal
 *   - "+ ADD EDGE" opens a modal that picks two services
 *   - Long-press / "REMOVE" button to delete (cascades edges)
 *
 * Drag-to-position on web is a polish item — for now positions are
 * auto-laid out by the server when omitted, and explicit x/y can be
 * set via chat (`update_service { x, y }`).
 */

interface Props {
  slug: string;
  architecture: Architecture | null;
  applyMutation: (envelope: unknown) => Promise<boolean>;
}

export function ArchitectureCanvas({ slug, architecture, applyMutation }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [edging, setEdging] = useState(false);
  const compact = useCompactLayout();

  const services = architecture?.services ?? [];
  const edges = architecture?.edges ?? [];
  const selected = services.find((s) => s.id === selectedId) ?? null;

  const incidentEdges = useMemo(() => {
    if (!selected) return { out: [], in: [] };
    return {
      out: edges.filter((e) => e.from_service_id === selected.id),
      in: edges.filter((e) => e.to_service_id === selected.id),
    };
  }, [selected, edges]);

  const serviceById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );

  const approvedAt = architecture?.approved_at;
  const approvalState: "empty" | "pending" | "approved" =
    services.length === 0 ? "empty" : approvedAt ? "approved" : "pending";

  return (
    <View style={styles.root}>
      <View style={[styles.header, compact && styles.headerCompact]}>
        <Text style={styles.kicker}>// ARCHITECTURE · {services.length}</Text>
        <View style={styles.headerActions}>
          <Pressable
            disabled={services.length < 2}
            onPress={() => setEdging(true)}
            style={({ pressed }) => [
              styles.btn,
              services.length < 2 && { opacity: 0.45 },
              pressed && services.length >= 2 && glow(palette.violet, 12),
            ]}
          >
            <Text style={[styles.btnText, { color: palette.violet }]}>+ EDGE</Text>
          </Pressable>
          <Pressable
            onPress={() => setAdding(true)}
            style={({ pressed }) => [styles.btn, pressed && glow(palette.cyan, 12)]}
          >
            <Text style={[styles.btnText, { color: palette.cyan }]}>+ SERVICE</Text>
          </Pressable>
        </View>
      </View>

      <ApprovalBanner
        state={approvalState}
        approvedAt={approvedAt}
        onApprove={() =>
          void applyMutation({
            kind: "approve_architecture",
            payload: { project_slug: slug },
          })
        }
        onUnapprove={() =>
          void applyMutation({
            kind: "unapprove_architecture",
            payload: { project_slug: slug },
          })
        }
      />

      <View style={styles.split}>
        <ScrollView style={styles.list} contentContainerStyle={[styles.listContent, compact && styles.listContentCompact]}>
          {services.length === 0 ? (
            <Empty />
          ) : (
            services.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                selected={s.id === selectedId}
                onSelect={() => setSelectedId(s.id)}
                onRemove={() =>
                  void applyMutation({
                    kind: "remove_service",
                    payload: { project_slug: slug, service_id: s.id },
                  }).then(() => {
                    if (selectedId === s.id) setSelectedId(null);
                  })
                }
              />
            ))
          )}
        </ScrollView>

        <View style={styles.detail}>
          {selected ? (
            <ServiceDetail
              service={selected}
              outgoing={incidentEdges.out.map((e) => ({
                edge: e,
                other: serviceById.get(e.to_service_id),
              }))}
              incoming={incidentEdges.in.map((e) => ({
                edge: e,
                other: serviceById.get(e.from_service_id),
              }))}
              onRemoveEdge={(edgeId) =>
                void applyMutation({
                  kind: "remove_arch_edge",
                  payload: { project_slug: slug, edge_id: edgeId },
                })
              }
            />
          ) : (
            <View style={styles.detailEmpty}>
              <Text style={styles.detailEmptyKicker}>// CANVAS</Text>
              <Text style={styles.detailEmptyTitle}>Pick a service</Text>
              <Text style={styles.detailEmptySub}>
                Tap a service in the list to inspect its incoming and outgoing edges.
                Use chat to ask the council to draft a starting topology, or click
                "+ SERVICE" to add boxes one at a time.
              </Text>
            </View>
          )}
        </View>
      </View>

      <AddServiceModal
        visible={adding}
        onCancel={() => setAdding(false)}
        onSubmit={async (input) => {
          const ok = await applyMutation({
            kind: "add_service",
            payload: { project_slug: slug, ...input },
          });
          if (ok) setAdding(false);
          return ok;
        }}
      />
      <AddEdgeModal
        visible={edging}
        services={services}
        onCancel={() => setEdging(false)}
        onSubmit={async (input) => {
          const ok = await applyMutation({
            kind: "add_arch_edge",
            payload: { project_slug: slug, ...input },
          });
          if (ok) setEdging(false);
          return ok;
        }}
      />
    </View>
  );
}

/**
 * Banner that surfaces the architecture's planning-gate state.
 *
 * Three states:
 *   - empty:    no services yet — no CTA, just a hint.
 *   - pending:  services exist, not yet approved → big APPROVE button.
 *   - approved: shows when, plus an "edits require re-approval" caveat
 *               and a small unapprove escape hatch.
 *
 * Approval timestamp is whatever the user last clicked. Any semantic
 * edit on the server clears it automatically; the client just re-renders.
 */
function ApprovalBanner({
  state,
  approvedAt,
  onApprove,
  onUnapprove,
}: {
  state: "empty" | "pending" | "approved";
  approvedAt: number | undefined;
  onApprove: () => void;
  onUnapprove: () => void;
}) {
  if (state === "empty") {
    return (
      <View style={[styles.approvalBanner, styles.approvalBannerEmpty]}>
        <View style={styles.approvalLeft}>
          <Text style={[styles.approvalPill, styles.approvalPillEmpty]}>EMPTY</Text>
          <Text style={styles.approvalText}>
            Task planning is blocked until at least one service exists and the
            architecture is approved.
          </Text>
        </View>
      </View>
    );
  }
  if (state === "pending") {
    return (
      <View style={[styles.approvalBanner, styles.approvalBannerPending]}>
        <View style={styles.approvalLeft}>
          <Text style={[styles.approvalPill, styles.approvalPillPending]}>
            AWAITING APPROVAL
          </Text>
          <Text style={styles.approvalText}>
            request_task_planning is blocked. Approve to unlock task planning
            project-wide. Edits to services or edges will reset this.
          </Text>
        </View>
        <Pressable
          onPress={onApprove}
          style={({ pressed }) => [styles.approveBtn, pressed && glow(palette.green, 14)]}
        >
          <Text style={styles.approveBtnText}>APPROVE ARCHITECTURE</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[styles.approvalBanner, styles.approvalBannerApproved]}>
      <View style={styles.approvalLeft}>
        <Text style={[styles.approvalPill, styles.approvalPillApproved]}>APPROVED</Text>
        <Text style={styles.approvalText}>
          Approved {formatApprovedAt(approvedAt)} · task planning is unlocked.
          Any edit will require re-approval.
        </Text>
      </View>
      <Pressable
        onPress={onUnapprove}
        style={({ pressed }) => [styles.unapproveBtn, pressed && styles.unapproveBtnPressed]}
      >
        <Text style={styles.unapproveBtnText}>UNAPPROVE</Text>
      </Pressable>
    </View>
  );
}

function formatApprovedAt(ts: number | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function ServiceRow({
  service,
  selected,
  onSelect,
  onRemove,
}: {
  service: ArchService;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const tone = toneForKind(service.kind);
  return (
    <Pressable
      onPress={onSelect}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.rowEdge, { backgroundColor: tone.fg }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowName} numberOfLines={1}>
            {service.name}
          </Text>
          <View style={[styles.kindPill, { borderColor: tone.border, backgroundColor: tone.bg }]}>
            <Text style={[styles.kindPillText, { color: tone.fg }]}>{service.kind.toUpperCase()}</Text>
          </View>
        </View>
        {service.description ? (
          <Text style={styles.rowDesc} numberOfLines={2}>
            {service.description}
          </Text>
        ) : null}
        <View style={styles.rowFoot}>
          <Text style={styles.rowMeta}>{service.id}</Text>
          <Pressable
            hitSlop={8}
            onPress={(e) => {
              e.stopPropagation?.();
              onRemove();
            }}
            style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
          >
            <Text style={styles.removeBtnText}>REMOVE</Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function ServiceDetail({
  service,
  outgoing,
  incoming,
  onRemoveEdge,
}: {
  service: ArchService;
  outgoing: Array<{ edge: { id: string; label?: string; kind?: string }; other: ArchService | undefined }>;
  incoming: Array<{ edge: { id: string; label?: string; kind?: string }; other: ArchService | undefined }>;
  onRemoveEdge: (edgeId: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.detailContent}>
      <Text style={styles.detailKicker}>// SERVICE</Text>
      <Text style={styles.detailName}>{service.name}</Text>
      {service.description ? (
        <Text style={styles.detailDesc}>{service.description}</Text>
      ) : null}

      <View style={styles.edgesSection}>
        <Text style={styles.edgesLabel}>OUTGOING ({outgoing.length})</Text>
        {outgoing.length === 0 ? (
          <Text style={styles.edgesEmpty}>(none)</Text>
        ) : (
          outgoing.map(({ edge, other }) => (
            <View key={edge.id} style={styles.edgeRow}>
              <Text style={styles.edgeArrow}>→</Text>
              <Text style={styles.edgeName} numberOfLines={1}>
                {other?.name ?? "(unknown)"}
              </Text>
              {edge.label ? <Text style={styles.edgeLabel}>"{edge.label}"</Text> : null}
              {edge.kind ? <Text style={styles.edgeKind}>{edge.kind}</Text> : null}
              <Pressable onPress={() => onRemoveEdge(edge.id)} style={styles.edgeRemove}>
                <Text style={styles.edgeRemoveText}>×</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>

      <View style={styles.edgesSection}>
        <Text style={styles.edgesLabel}>INCOMING ({incoming.length})</Text>
        {incoming.length === 0 ? (
          <Text style={styles.edgesEmpty}>(none)</Text>
        ) : (
          incoming.map(({ edge, other }) => (
            <View key={edge.id} style={styles.edgeRow}>
              <Text style={styles.edgeArrow}>←</Text>
              <Text style={styles.edgeName} numberOfLines={1}>
                {other?.name ?? "(unknown)"}
              </Text>
              {edge.label ? <Text style={styles.edgeLabel}>"{edge.label}"</Text> : null}
              {edge.kind ? <Text style={styles.edgeKind}>{edge.kind}</Text> : null}
              <Pressable onPress={() => onRemoveEdge(edge.id)} style={styles.edgeRemove}>
                <Text style={styles.edgeRemoveText}>×</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function AddServiceModal({
  visible,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (input: { name: string; kind: ServiceKind; description?: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ServiceKind>("service");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const compact = useCompactLayout();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.modalBackdrop, compact && compactModalBackdrop]}>
        <View style={[styles.modalCard, compact && compactModalCard]}>
          <Text style={styles.modalKicker}>// new service</Text>
          <Text style={styles.modalTitle}>Add a service to the map</Text>
          <Text style={styles.modalLabel}>NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. auth-service"
            placeholderTextColor={palette.textMuted}
            style={styles.modalInput}
          />
          <Text style={styles.modalLabel}>KIND</Text>
          <View style={styles.kindRow}>
            {SERVICE_KINDS.map((k) => (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                style={({ pressed }) => [
                  styles.kindChoice,
                  k === kind && styles.kindChoiceActive,
                  pressed && glow(palette.cyan, 8),
                ]}
              >
                <Text style={[styles.kindChoiceText, k === kind && styles.kindChoiceTextActive]}>
                  {k}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.modalLabel}>DESCRIPTION (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="role of this service in the system"
            placeholderTextColor={palette.textMuted}
            style={[styles.modalInput, { minHeight: 64 }]}
            multiline
          />
          <View style={styles.modalBtns}>
            <Pressable onPress={onCancel} style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>CANCEL</Text>
            </Pressable>
            <Pressable
              disabled={busy || name.trim().length === 0}
              onPress={async () => {
                setBusy(true);
                const ok = await onSubmit({
                  name: name.trim(),
                  kind,
                  description: description.trim() || undefined,
                });
                setBusy(false);
                if (ok) {
                  setName("");
                  setKind("service");
                  setDescription("");
                }
              }}
              style={({ pressed }) => [
                styles.modalSubmit,
                (busy || name.trim().length === 0) && { opacity: 0.45 },
                pressed && glow(palette.cyan, 12),
              ]}
            >
              <Text style={styles.modalSubmitText}>{busy ? "ADDING…" : "ADD SERVICE"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AddEdgeModal({
  visible,
  services,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  services: ArchService[];
  onCancel: () => void;
  onSubmit: (input: {
    from_service_id: string;
    to_service_id: string;
    label?: string;
    kind?: "request" | "event" | "data" | "dep";
  }) => Promise<boolean>;
}) {
  const [from, setFrom] = useState<string>(services[0]?.id ?? "");
  const [to, setTo] = useState<string>(services[1]?.id ?? "");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"request" | "event" | "data" | "dep">("request");
  const [busy, setBusy] = useState(false);

  const valid = from && to && from !== to;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalKicker}>// new edge</Text>
          <Text style={styles.modalTitle}>Connect two services</Text>

          <Text style={styles.modalLabel}>FROM</Text>
          <ServicePicker services={services} value={from} onChange={setFrom} />
          <Text style={styles.modalLabel}>TO</Text>
          <ServicePicker services={services} value={to} onChange={setTo} />

          <Text style={styles.modalLabel}>KIND</Text>
          <View style={styles.kindRow}>
            {(["request", "event", "data", "dep"] as const).map((k) => (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                style={({ pressed }) => [
                  styles.kindChoice,
                  k === kind && styles.kindChoiceActive,
                  pressed && glow(palette.violet, 8),
                ]}
              >
                <Text style={[styles.kindChoiceText, k === kind && styles.kindChoiceTextActive]}>
                  {k}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.modalLabel}>LABEL (optional)</Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="e.g. fetch user, publish event"
            placeholderTextColor={palette.textMuted}
            style={styles.modalInput}
          />

          <View style={styles.modalBtns}>
            <Pressable onPress={onCancel} style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>CANCEL</Text>
            </Pressable>
            <Pressable
              disabled={!valid || busy}
              onPress={async () => {
                setBusy(true);
                const ok = await onSubmit({
                  from_service_id: from,
                  to_service_id: to,
                  label: label.trim() || undefined,
                  kind,
                });
                setBusy(false);
                if (ok) setLabel("");
              }}
              style={({ pressed }) => [
                styles.modalSubmit,
                (!valid || busy) && { opacity: 0.45 },
                pressed && glow(palette.violet, 12),
              ]}
            >
              <Text style={styles.modalSubmitText}>{busy ? "ADDING…" : "ADD EDGE"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ServicePicker({
  services,
  value,
  onChange,
}: {
  services: ArchService[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerScroll}>
      <View style={styles.pickerRow}>
        {services.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => onChange(s.id)}
            style={({ pressed }) => [
              styles.pickerChip,
              s.id === value && styles.pickerChipActive,
              pressed && glow(palette.cyan, 8),
            ]}
          >
            <Text style={[styles.pickerChipText, s.id === value && styles.pickerChipTextActive]}>
              {s.name}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function Empty() {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyKicker}>// PHASE 8</Text>
      <Text style={styles.emptyTitle}>No services yet</Text>
      <Text style={styles.emptySub}>
        Sketch your system as a topology of services, datastores, queues,
        and external dependencies. Click "+ SERVICE" to add a box, then
        connect them with edges.
      </Text>
    </View>
  );
}

function toneForKind(kind: ServiceKind): { fg: string; bg: string; border: string } {
  switch (kind) {
    case "service":
      return { fg: palette.cyan, bg: "rgba(92,246,255,0.06)", border: "rgba(92,246,255,0.32)" };
    case "datastore":
      return { fg: palette.violet, bg: "rgba(183,139,255,0.07)", border: "rgba(183,139,255,0.34)" };
    case "queue":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.07)", border: "rgba(255,180,84,0.32)" };
    case "external":
      return { fg: palette.rose, bg: "rgba(255,107,155,0.07)", border: "rgba(255,107,155,0.32)" };
    case "client":
      return { fg: palette.green, bg: "rgba(118,245,176,0.07)", border: "rgba(118,245,176,0.32)" };
    case "infra":
    default:
      return { fg: palette.textSecondary, bg: "rgba(80,96,116,0.18)", border: palette.borderHair };
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  headerCompact: {
    flexWrap: "wrap",
    rowGap: space.sm,
    alignItems: "flex-start",
    paddingHorizontal: space.md,
  },
  kicker: {
    color: palette.violetDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.6,
  },
  headerActions: { flexDirection: "row", gap: space.sm },
  btn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: palette.bgBase,
  },
  btnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },

  approvalBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
  },
  approvalBannerEmpty: { backgroundColor: "rgba(80,96,116,0.10)" },
  approvalBannerPending: { backgroundColor: "rgba(255,180,84,0.08)" },
  approvalBannerApproved: { backgroundColor: "rgba(118,245,176,0.08)" },
  approvalLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  approvalPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  approvalPillEmpty: {
    color: palette.textMuted,
    borderColor: palette.borderHair,
    backgroundColor: "rgba(80,96,116,0.18)",
  },
  approvalPillPending: {
    color: palette.amber,
    borderColor: palette.amber,
    backgroundColor: "rgba(255,180,84,0.10)",
  },
  approvalPillApproved: {
    color: palette.green,
    borderColor: palette.green,
    backgroundColor: "rgba(118,245,176,0.12)",
  },
  approvalText: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
  },
  approveBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.green,
    backgroundColor: "rgba(118,245,176,0.10)",
  },
  approveBtnText: {
    color: palette.green,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  unapproveBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  unapproveBtnPressed: { backgroundColor: "rgba(80,96,116,0.18)" },
  unapproveBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: "600",
  },

  split: { flex: 1, flexDirection: Platform.OS === "web" ? "row" : "column" },
  list: {
    flex: Platform.OS === "web" ? 0 : 1,
    width: Platform.OS === "web" ? 360 : undefined,
    borderRightWidth: Platform.OS === "web" ? 1 : 0,
    borderRightColor: palette.borderHair,
    backgroundColor: palette.bgBase,
  },
  listContent: { padding: space.lg, gap: space.sm },
  listContentCompact: { padding: space.md },

  row: {
    flexDirection: "row",
    backgroundColor: palette.bgPanel,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    overflow: "hidden",
  },
  rowPressed: { backgroundColor: "rgba(92,246,255,0.04)" },
  rowSelected: { borderColor: palette.cyan, ...glow(palette.cyanGlow, 8) },
  rowEdge: { width: 3 },
  rowBody: { flex: 1, padding: space.md, gap: 6, minWidth: 0 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 14, fontWeight: "600", flex: 1 },
  rowDesc: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  rowFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowMeta: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 10 },

  kindPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  kindPillText: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2, fontWeight: "600" },

  removeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  removeBtnPressed: { backgroundColor: "rgba(255,107,107,0.08)", borderColor: "rgba(255,107,107,0.4)" },
  removeBtnText: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.2 },

  detail: { flex: 1, backgroundColor: palette.bgRaised },
  detailContent: { padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 },
  detailKicker: { color: palette.cyanDim, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4 },
  detailName: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 22, fontWeight: "700" },
  detailDesc: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 13, lineHeight: 19 },

  detailEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 6,
  },
  detailEmptyKicker: { color: palette.cyanDim, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  detailEmptyTitle: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 18, fontWeight: "600" },
  detailEmptySub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 460,
    lineHeight: 19,
  },

  edgesSection: { gap: 6, marginTop: space.sm },
  edgesLabel: { color: palette.violetDim, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4 },
  edgesEmpty: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 11 },
  edgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  edgeArrow: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 14 },
  edgeName: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 13, fontWeight: "600" },
  edgeLabel: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 12, fontStyle: "italic" },
  edgeKind: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: palette.violetDim,
    borderRadius: radii.pill,
  },
  edgeRemove: { marginLeft: "auto", padding: 4 },
  edgeRemoveText: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 14 },

  empty: {
    padding: space.xl,
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: palette.borderHair,
    borderRadius: radii.md,
  },
  emptyKicker: { color: palette.violet, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  emptyTitle: { color: palette.textPrimary, fontSize: 18, fontWeight: "600", fontFamily: fonts.body },
  emptySub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 380,
    lineHeight: 19,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(5, 7, 13, 0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: space.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    padding: space.xl,
    gap: 6,
  },
  modalKicker: { color: palette.cyanDim, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  modalTitle: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 20, fontWeight: "700" },
  modalLabel: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    marginTop: space.md,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 13,
    backgroundColor: palette.bgBase,
  },

  kindRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  kindChoice: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderHair,
    backgroundColor: palette.bgBase,
  },
  kindChoiceActive: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  kindChoiceText: { color: palette.textSecondary, fontFamily: fonts.mono, fontSize: 11 },
  kindChoiceTextActive: { color: palette.cyan, fontWeight: "700" },

  pickerScroll: { marginTop: 4 },
  pickerRow: { flexDirection: "row", gap: 6 },
  pickerChip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderHair,
    backgroundColor: palette.bgBase,
  },
  pickerChipActive: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  pickerChipText: { color: palette.textSecondary, fontFamily: fonts.body, fontSize: 13 },
  pickerChipTextActive: { color: palette.cyan, fontWeight: "700" },

  modalBtns: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.md },
  modalCancel: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderHair,
  },
  modalCancelText: { color: palette.textSecondary, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4 },
  modalSubmit: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: palette.bgBase,
  },
  modalSubmitText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
});
