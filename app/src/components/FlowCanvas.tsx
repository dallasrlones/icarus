import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import type {
  Architecture,
  CouncilRun,
  Feature,
  FeatureStatus,
  Flow,
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  ResolvedPersona,
} from "../types";
import { CouncilPanel } from "./CouncilPanel";
import { COMPACT_BREAKPOINT, useCompactLayout } from "../layout/compact";
import { compactModalBackdrop, compactModalCard } from "../layout/compactModal";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Flow section.
 *
 * v2 UX:
 *   - Default OUTLINE view: a numbered vertical card list. Each card shows
 *     the node's kind, label (tap to edit), description (tap to edit), and
 *     its outgoing edges as compact chips. Adding a node from the
 *     quick-add bar with a card selected auto-wires the new node from the
 *     selected one — chains build with Enter, Enter, Enter.
 *   - CANVAS view (web only, opt-in): the original absolute-positioned
 *     drag canvas with an "Auto-arrange" button that topo-sorts the nodes
 *     into a clean left-to-right grid. Edge mode is still available for
 *     wiring two existing nodes after the fact.
 *   - Quick-add composer at the top in both modes (text input + tiny kind
 *     selector + Enter). The "advanced" modal stays available for adding
 *     a description at create time, but the composer covers 90% of work.
 *   - Inline edit on labels / descriptions / edge labels — no more delete
 *     and re-add to fix a typo.
 *   - Feature picker chips show a status dot per feature so you can scan
 *     where each one sits in the flow → tasks pipeline.
 *
 * The component still emits standard mutation envelopes through the
 * parent's `applyMutation`. Parent-side WS subscriptions handle refresh.
 */

interface Props {
  slug: string;
  features: Feature[];
  flows: Flow[];
  selectedFeatureId: string | null;
  onSelectFeature: (id: string | null) => void;
  applyMutation: (envelope: unknown) => Promise<boolean>;
  /** Council runs for the currently-selected feature (if any). */
  councilRuns?: CouncilRun[];
  /**
   * Project architecture, used to drive the planning gate on the council
   * panel. The "Plan tasks" button is only enabled when the architecture
   * has at least one service AND a current `approved_at` stamp.
   */
  architecture?: Architecture | null;
  /**
   * Phase 14 — resolved lens panel for this project (defaults +
   * globals + project overrides). The council panel uses this to
   * paint each lens card with its persona's accent color so a
   * "marketing" lens reads visually distinct from the default UX
   * lens. Optional; when missing we fall back to lens-id defaults.
   */
  resolvedPersonas?: ResolvedPersona[];
}

type FlowMode = "outline" | "canvas";

// Canvas geometry
const STAGE_W = 1400;
const STAGE_H = 900;
const NODE_W = 180;
const NODE_H = 64;
const AUTO_COL = 220; // px between columns in auto-arrange
const AUTO_ROW = 110; // px between rows in auto-arrange
const AUTO_PAD = 40;

// Council panel side-by-side breakpoint
const WIDE_BREAKPOINT = 980;

const KINDS: FlowNodeKind[] = ["step", "decision", "io", "external"];

export function FlowCanvas({
  slug,
  features,
  flows,
  selectedFeatureId,
  onSelectFeature,
  applyMutation,
  councilRuns = [],
  architecture,
  resolvedPersonas,
}: Props) {
  const architectureState: "empty" | "pending" | "approved" =
    !architecture || architecture.services.length === 0
      ? "empty"
      : architecture.approved_at
        ? "approved"
        : "pending";
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  const compactFlow = width < COMPACT_BREAKPOINT;

  const visibleFeatures = features.filter((f) => f.status !== "archived");
  const activeFeatureId =
    selectedFeatureId ?? (visibleFeatures.length > 0 ? visibleFeatures[0].id : null);
  const activeFeature = visibleFeatures.find((f) => f.id === activeFeatureId) ?? null;
  const activeFlow = flows.find((f) => f.feature_id === activeFeatureId) ?? null;

  // Mode: outline by default everywhere; canvas opt-in on web wide screens.
  // Mobile (RN native) is outline-only — the absolute-positioned canvas
  // doesn't make sense on a phone.
  const canvasAvailable = Platform.OS === "web";
  const [mode, setMode] = useState<FlowMode>("outline");
  const effectiveMode: FlowMode = canvasAvailable ? mode : "outline";

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [edgeSourceId, setEdgeSourceId] = useState<string | null>(null);
  const [advancedAddOpen, setAdvancedAddOpen] = useState(false);

  // Reset transient state when the active feature changes.
  useEffect(() => {
    setSelectedNodeId(null);
    setEdgeSourceId(null);
  }, [activeFeatureId]);

  const onTapNode = useCallback(
    async (node: FlowNode) => {
      if (edgeSourceId && edgeSourceId !== node.id) {
        const ok = await applyMutation({
          kind: "add_flow_edge",
          payload: {
            project_slug: slug,
            feature_id: node.feature_id,
            from_node_id: edgeSourceId,
            to_node_id: node.id,
          },
        });
        if (ok) setEdgeSourceId(null);
        return;
      }
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [edgeSourceId, applyMutation, slug],
  );

  const updateNode = useCallback(
    async (
      node: FlowNode,
      patch: Partial<Pick<FlowNode, "label" | "description" | "kind" | "x" | "y">>,
    ) => {
      return await applyMutation({
        kind: "update_flow_node",
        payload: {
          project_slug: slug,
          feature_id: node.feature_id,
          node_id: node.id,
          ...patch,
        },
      });
    },
    [applyMutation, slug],
  );

  const removeNode = useCallback(
    async (node: FlowNode) => {
      const ok = await applyMutation({
        kind: "remove_flow_node",
        payload: { project_slug: slug, feature_id: node.feature_id, node_id: node.id },
      });
      if (ok) setSelectedNodeId(null);
    },
    [applyMutation, slug],
  );

  const updateEdgeLabel = useCallback(
    async (edge: FlowEdge, label: string) => {
      return await applyMutation({
        kind: "update_flow_edge",
        payload: {
          project_slug: slug,
          feature_id: edge.feature_id,
          edge_id: edge.id,
          label,
        },
      });
    },
    [applyMutation, slug],
  );

  const removeEdge = useCallback(
    async (edge: FlowEdge) => {
      await applyMutation({
        kind: "remove_flow_edge",
        payload: { project_slug: slug, feature_id: edge.feature_id, edge_id: edge.id },
      });
    },
    [applyMutation, slug],
  );

  const addNode = useCallback(
    async (input: {
      label: string;
      kind?: FlowNodeKind;
      description?: string;
      autoEdgeFrom?: string | null;
    }): Promise<boolean> => {
      if (!activeFeature) return false;
      const ok = await applyMutation({
        kind: "add_flow_node",
        payload: {
          project_slug: slug,
          feature_id: activeFeature.id,
          label: input.label,
          kind: input.kind,
          description: input.description,
        },
      });
      if (!ok) return false;
      // Best-effort auto-edge wiring. The new node id isn't in the
      // mutation result envelope today, so we look it up post-WS-refresh
      // via a poll-by-label heuristic. Cheap and fine for click-ops.
      if (input.autoEdgeFrom) {
        await wireAutoEdge(
          { applyMutation, slug, featureId: activeFeature.id },
          input.autoEdgeFrom,
          input.label,
        );
      }
      return true;
    },
    [activeFeature, applyMutation, slug],
  );

  const moveNode = useCallback(
    async (node: FlowNode, x: number, y: number) => {
      await updateNode(node, { x, y });
    },
    [updateNode],
  );

  const onAutoArrange = useCallback(async () => {
    if (!activeFlow) return;
    const positions = autoArrangePositions(activeFlow);
    for (const node of activeFlow.nodes) {
      const p = positions.get(node.id);
      if (!p) continue;
      if (Math.abs(p.x - node.x) < 1 && Math.abs(p.y - node.y) < 1) continue;
      await updateNode(node, { x: p.x, y: p.y });
    }
  }, [activeFlow, updateNode]);

  if (visibleFeatures.length === 0) {
    return <EmptyFeaturesState />;
  }

  const selectedNode = activeFlow?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <View style={styles.root}>
      <FeaturePicker
        compact={compactFlow}
        features={visibleFeatures}
        activeId={activeFeatureId}
        onPick={(id) => onSelectFeature(id)}
      />

      <FlowToolbar
        compact={compactFlow}
        feature={activeFeature}
        flow={activeFlow}
        mode={effectiveMode}
        canvasAvailable={canvasAvailable}
        onModeChange={setMode}
        onOpenAdvanced={() => setAdvancedAddOpen(true)}
        onAutoArrange={effectiveMode === "canvas" ? onAutoArrange : undefined}
      />

      <QuickAddBar
        compact={compactFlow}
        disabled={!activeFeature}
        autoEdgeFromName={selectedNode?.label}
        onClearAutoEdge={() => setSelectedNodeId(null)}
        onSubmit={async (label, kind) => {
          const ok = await addNode({
            label,
            kind,
            autoEdgeFrom: selectedNode?.id ?? null,
          });
          return ok;
        }}
      />

      {edgeSourceId ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Wiring edge — tap a target node to connect, or
          </Text>
          <Pressable onPress={() => setEdgeSourceId(null)} style={styles.bannerCancel}>
            <Text style={styles.bannerCancelText}>CANCEL</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.body, !isWide && styles.bodyStacked]}>
        <View style={styles.bodyMain}>
          {effectiveMode === "outline" ? (
            <OutlineView
              compact={compactFlow}
              flow={activeFlow}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) =>
                setSelectedNodeId((prev) => (prev === id ? null : id))
              }
              onUpdateNode={updateNode}
              onRemoveNode={removeNode}
              onUpdateEdgeLabel={updateEdgeLabel}
              onRemoveEdge={removeEdge}
              onStartWire={(id) => setEdgeSourceId(id)}
              edgeSourceId={edgeSourceId}
              onCompleteWire={async (toNode) => {
                if (!edgeSourceId || edgeSourceId === toNode.id) return;
                const ok = await applyMutation({
                  kind: "add_flow_edge",
                  payload: {
                    project_slug: slug,
                    feature_id: toNode.feature_id,
                    from_node_id: edgeSourceId,
                    to_node_id: toNode.id,
                  },
                });
                if (ok) setEdgeSourceId(null);
              }}
            />
          ) : (
            <CanvasView
              flow={activeFlow}
              selectedNodeId={selectedNodeId}
              edgeSourceId={edgeSourceId}
              onTapNode={onTapNode}
              onMoveNode={moveNode}
              onRemoveNode={removeNode}
              onRemoveEdge={removeEdge}
              onUpdateEdgeLabel={updateEdgeLabel}
              onStartWire={(id) => setEdgeSourceId(id)}
            />
          )}
        </View>

        {activeFeature ? (
          <View style={[styles.councilRail, !isWide && styles.councilRailStacked]}>
            <CouncilPanel
              feature={activeFeature}
              runs={councilRuns}
              architectureState={architectureState}
              resolvedPersonas={resolvedPersonas}
              onRequestReview={() =>
                void applyMutation({
                  kind: "request_flow_review",
                  payload: { project_slug: slug, feature_id: activeFeature.id },
                })
              }
              onApproveFlow={(runId) =>
                void applyMutation({
                  kind: "approve_flow",
                  payload: {
                    project_slug: slug,
                    feature_id: activeFeature.id,
                    ...(runId ? { run_id: runId } : {}),
                  },
                })
              }
              onRequestChanges={() =>
                void applyMutation({
                  kind: "request_flow_changes",
                  payload: { project_slug: slug, feature_id: activeFeature.id },
                })
              }
              onPlanTasks={() =>
                void applyMutation({
                  kind: "request_task_planning",
                  payload: { project_slug: slug, feature_id: activeFeature.id },
                })
              }
            />
          </View>
        ) : null}
      </View>

      <NewNodeModal
        visible={advancedAddOpen}
        onCancel={() => setAdvancedAddOpen(false)}
        onSubmit={async (input) => {
          const ok = await addNode({
            ...input,
            autoEdgeFrom: selectedNode?.id ?? null,
          });
          if (ok) setAdvancedAddOpen(false);
          return ok;
        }}
      />
    </View>
  );
}

// ===================================================================
// Feature picker
// ===================================================================

function FeaturePicker({
  compact,
  features,
  activeId,
  onPick,
}: {
  compact?: boolean;
  features: Feature[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.pickerRow, compact && styles.pickerRowCompact]}
    >
      {features.map((f) => {
        const active = f.id === activeId;
        const dot = featureStatusDot(f.status);
        return (
          <Pressable
            key={f.id}
            onPress={() => onPick(f.id)}
            style={[styles.pickerChip, active && styles.pickerChipActive]}
          >
            <View style={[styles.pickerDot, { backgroundColor: dot.color }]} />
            <Text
              style={[styles.pickerLabel, compact && styles.pickerLabelCompact, active && styles.pickerLabelActive]}
              numberOfLines={1}
            >
              {f.name}
            </Text>
            <Text style={[styles.pickerStatus, { color: dot.color }]}>{dot.short}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function featureStatusDot(status: FeatureStatus): { color: string; short: string } {
  switch (status) {
    case "draft":         return { color: palette.textMuted, short: "DRAFT" };
    case "flowing":       return { color: palette.cyan,      short: "FLOW" };
    case "flow_review":   return { color: palette.violet,    short: "REVIEW" };
    case "flow_approved": return { color: palette.green,     short: "OK" };
    case "planning":      return { color: palette.violet,    short: "PLAN" };
    case "planned":       return { color: palette.green,     short: "READY" };
    case "in_progress":   return { color: palette.amber,     short: "BUILD" };
    case "done":          return { color: palette.green,     short: "DONE" };
    case "archived":      return { color: palette.textMuted, short: "ARCH" };
  }
}

// ===================================================================
// Toolbar
// ===================================================================

function FlowToolbar({
  compact,
  feature,
  flow,
  mode,
  canvasAvailable,
  onModeChange,
  onOpenAdvanced,
  onAutoArrange,
}: {
  compact?: boolean;
  feature: Feature | null;
  flow: Flow | null;
  mode: FlowMode;
  canvasAvailable: boolean;
  onModeChange: (m: FlowMode) => void;
  onOpenAdvanced: () => void;
  onAutoArrange?: () => void;
}) {
  return (
    <View style={[styles.toolbar, compact && styles.toolbarCompact]}>
      <View style={styles.toolbarLeft}>
        <Text style={styles.toolbarLabel} numberOfLines={1}>
          {feature ? feature.name : "—"}
        </Text>
        <Text style={styles.toolbarMeta}>
          {(flow?.nodes.length ?? 0)} nodes · {(flow?.edges.length ?? 0)} edges
        </Text>
      </View>
      <View style={[styles.toolbarRight, compact && styles.toolbarRightCompact]}>
        {onAutoArrange && (flow?.nodes.length ?? 0) > 1 ? (
          <Pressable
            onPress={onAutoArrange}
            style={({ pressed }) => [styles.toolBtn, pressed && styles.toolBtnPressed]}
          >
            <Text style={styles.toolBtnText}>AUTO-ARRANGE</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onOpenAdvanced}
          disabled={!feature}
          style={({ pressed }) => [
            styles.toolBtn,
            pressed && styles.toolBtnPressed,
            !feature && styles.toolBtnDisabled,
          ]}
        >
          <Text style={styles.toolBtnText}>ADV. ADD</Text>
        </Pressable>
        {canvasAvailable ? (
          <View style={styles.modeToggle}>
            <Pressable
              onPress={() => onModeChange("outline")}
              style={[styles.modeBtn, mode === "outline" && styles.modeBtnActive]}
            >
              <Text style={[styles.modeText, mode === "outline" && styles.modeTextActive]}>
                OUTLINE
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onModeChange("canvas")}
              style={[styles.modeBtn, mode === "canvas" && styles.modeBtnActive]}
            >
              <Text style={[styles.modeText, mode === "canvas" && styles.modeTextActive]}>
                CANVAS
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ===================================================================
// Quick-add bar (Enter to add)
// ===================================================================

function QuickAddBar({
  compact,
  disabled,
  autoEdgeFromName,
  onClearAutoEdge,
  onSubmit,
}: {
  compact?: boolean;
  disabled: boolean;
  autoEdgeFromName?: string;
  onClearAutoEdge: () => void;
  onSubmit: (label: string, kind: FlowNodeKind) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FlowNodeKind>("step");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed || busy || disabled) return;
    setBusy(true);
    const ok = await onSubmit(trimmed, kind);
    setBusy(false);
    if (ok) setLabel("");
  }, [label, kind, onSubmit, busy, disabled]);

  // Enter submits; Shift+Enter is reserved for "drop into advanced add" but
  // for now just submits as normal.
  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (e.nativeEvent.key === "Enter") {
      e.preventDefault?.();
      void submit();
    }
  };

  return (
    <View style={[styles.quickAddWrap, compact && styles.quickAddWrapCompact]}>
      <View style={styles.quickAddRow}>
        <Text style={styles.quickAddPrefix}>+ NODE</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder={
            autoEdgeFromName
              ? `next after "${truncate(autoEdgeFromName, 32)}"…`
              : "type a step and press enter…"
          }
          placeholderTextColor={palette.textMuted}
          editable={!disabled}
          style={[styles.quickAddInput, compact && styles.quickAddInputCompact]}
          onKeyPress={onKeyPress}
          onSubmitEditing={() => void submit()}
          returnKeyType="done"
        />
        <View style={styles.kindPills}>
          {KINDS.map((k) => {
            const active = kind === k;
            const tone = nodeKindTone(k);
            return (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                style={[
                  styles.kindPill,
                  {
                    borderColor: active ? tone.fg : palette.borderSoft,
                    backgroundColor: active ? tone.bg : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.kindPillText,
                    { color: active ? tone.fg : palette.textSecondary },
                  ]}
                >
                  {kindAbbrev(k)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          onPress={() => void submit()}
          disabled={!label.trim() || busy || disabled}
          style={({ pressed }) => [
            styles.quickAddBtn,
            (!label.trim() || busy || disabled) && styles.quickAddBtnDisabled,
            pressed && styles.toolBtnPressed,
          ]}
        >
          <Text style={styles.quickAddBtnText}>{busy ? "…" : "ADD"}</Text>
        </Pressable>
      </View>
      {autoEdgeFromName ? (
        <View style={styles.fromRow}>
          <Text style={styles.fromLabel}>// auto-wires from</Text>
          <Text style={styles.fromName} numberOfLines={1}>
            {autoEdgeFromName}
          </Text>
          <Pressable onPress={onClearAutoEdge} style={styles.fromClear}>
            <Text style={styles.fromClearText}>✕</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function kindAbbrev(k: FlowNodeKind): string {
  switch (k) {
    case "step": return "STEP";
    case "decision": return "DEC.";
    case "io": return "I/O";
    case "external": return "EXT.";
  }
}

// ===================================================================
// Outline view
// ===================================================================

function OutlineView({
  compact,
  flow,
  selectedNodeId,
  onSelectNode,
  onUpdateNode,
  onRemoveNode,
  onUpdateEdgeLabel,
  onRemoveEdge,
  onStartWire,
  edgeSourceId,
  onCompleteWire,
}: {
  compact?: boolean;
  flow: Flow | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onUpdateNode: (
    node: FlowNode,
    patch: Partial<Pick<FlowNode, "label" | "description" | "kind" | "x" | "y">>,
  ) => Promise<boolean | undefined>;
  onRemoveNode: (node: FlowNode) => Promise<void>;
  onUpdateEdgeLabel: (edge: FlowEdge, label: string) => Promise<boolean | undefined>;
  onRemoveEdge: (edge: FlowEdge) => Promise<void>;
  onStartWire: (fromId: string) => void;
  edgeSourceId: string | null;
  onCompleteWire: (toNode: FlowNode) => Promise<void>;
}) {
  if (!flow || flow.nodes.length === 0) {
    return (
      <View style={[styles.outlineEmpty, compact && styles.outlineEmptyCompact]}>
        <Text style={styles.outlineEmptyTitle}>Empty flow</Text>
        <Text style={styles.outlineEmptySub}>
          Use the quick-add bar above to draft your first step. Press
          Enter to add. Pick a card, then add another to chain them.
        </Text>
      </View>
    );
  }

  const ordered = useMemo(() => topologicalOrder(flow), [flow]);
  const nodeById = useMemo(() => {
    const m = new Map<string, FlowNode>();
    for (const n of flow.nodes) m.set(n.id, n);
    return m;
  }, [flow]);

  return (
    <ScrollView
      style={styles.outlineScroll}
      contentContainerStyle={[styles.outlineContent, compact && styles.outlineContentCompact]}
    >
      {ordered.map((node, i) => {
        const outgoing = flow.edges.filter((e) => e.from_node_id === node.id);
        const isSelected = selectedNodeId === node.id;
        const isWireSource = edgeSourceId === node.id;
        const isWireTarget = !!edgeSourceId && edgeSourceId !== node.id;
        return (
          <OutlineRow
            key={node.id}
            index={i + 1}
            node={node}
            outgoing={outgoing}
            nodeById={nodeById}
            selected={isSelected}
            wireSource={isWireSource}
            wireTarget={isWireTarget}
            onTap={() => {
              if (isWireTarget) void onCompleteWire(node);
              else onSelectNode(node.id);
            }}
            onUpdateNode={onUpdateNode}
            onRemoveNode={onRemoveNode}
            onUpdateEdgeLabel={onUpdateEdgeLabel}
            onRemoveEdge={onRemoveEdge}
            onStartWire={() => onStartWire(node.id)}
          />
        );
      })}
    </ScrollView>
  );
}

function OutlineRow({
  index,
  node,
  outgoing,
  nodeById,
  selected,
  wireSource,
  wireTarget,
  onTap,
  onUpdateNode,
  onRemoveNode,
  onUpdateEdgeLabel,
  onRemoveEdge,
  onStartWire,
}: {
  index: number;
  node: FlowNode;
  outgoing: FlowEdge[];
  nodeById: Map<string, FlowNode>;
  selected: boolean;
  wireSource: boolean;
  wireTarget: boolean;
  onTap: () => void;
  onUpdateNode: (
    node: FlowNode,
    patch: Partial<Pick<FlowNode, "label" | "description" | "kind" | "x" | "y">>,
  ) => Promise<boolean | undefined>;
  onRemoveNode: (node: FlowNode) => Promise<void>;
  onUpdateEdgeLabel: (edge: FlowEdge, label: string) => Promise<boolean | undefined>;
  onRemoveEdge: (edge: FlowEdge) => Promise<void>;
  onStartWire: () => void;
}) {
  const tone = nodeKindTone(node.kind);

  return (
    <Pressable
      onPress={onTap}
      style={[
        styles.outlineCard,
        { borderLeftColor: tone.fg },
        selected && styles.outlineCardSelected,
        wireSource && styles.outlineCardWireSource,
        wireTarget && styles.outlineCardWireTarget,
      ]}
    >
      <View style={styles.outlineHeader}>
        <View style={[styles.outlineNum, { borderColor: tone.fg }]}>
          <Text style={[styles.outlineNumText, { color: tone.fg }]}>{index}</Text>
        </View>
        <Text style={[styles.outlineKind, { color: tone.fg }]}>
          {kindAbbrev(node.kind ?? "step")}
        </Text>
        <View style={{ flex: 1 }}>
          <EditableText
            value={node.label}
            placeholder="(unnamed step)"
            onSubmit={(v) => onUpdateNode(node, { label: v })}
            style={styles.outlineTitle}
            singleLine
          />
        </View>
        {selected ? (
          <View style={styles.outlineActions}>
            <KindMenu
              current={node.kind ?? "step"}
              onPick={(k) => void onUpdateNode(node, { kind: k })}
            />
            <Pressable
              onPress={onStartWire}
              style={({ pressed }) => [styles.miniBtn, pressed && styles.toolBtnPressed]}
            >
              <Text style={styles.miniBtnText}>WIRE →</Text>
            </Pressable>
            <Pressable
              onPress={() => void onRemoveNode(node)}
              style={({ pressed }) => [
                styles.miniBtn,
                styles.miniBtnDanger,
                pressed && styles.toolBtnPressed,
              ]}
            >
              <Text style={styles.miniBtnDangerText}>DELETE</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {(selected || node.description) ? (
        <EditableText
          value={node.description ?? ""}
          placeholder={selected ? "// add a description (tap to edit)" : ""}
          onSubmit={(v) => onUpdateNode(node, { description: v.length === 0 ? "" : v })}
          style={styles.outlineDesc}
          multiline
        />
      ) : null}

      {outgoing.length > 0 ? (
        <View style={styles.outlineEdges}>
          {outgoing.map((e) => {
            const target = nodeById.get(e.to_node_id);
            return (
              <EdgeChip
                key={e.id}
                edge={e}
                targetLabel={target?.label ?? "?"}
                onUpdateLabel={(label) => onUpdateEdgeLabel(e, label)}
                onRemove={() => onRemoveEdge(e)}
              />
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

function EdgeChip({
  edge,
  targetLabel,
  onUpdateLabel,
  onRemove,
}: {
  edge: FlowEdge;
  targetLabel: string;
  onUpdateLabel: (label: string) => Promise<boolean | undefined>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edge.label ?? "");

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if ((edge.label ?? "") === next) return;
    await onUpdateLabel(next);
  };

  if (editing) {
    return (
      <View style={[styles.edgeChip, styles.edgeChipEditing]}>
        <Text style={styles.edgeArrow}>→</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="label"
          placeholderTextColor={palette.textMuted}
          style={styles.edgeChipInput}
          autoFocus
          onBlur={() => void commit()}
          onSubmitEditing={() => void commit()}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Escape") {
              setDraft(edge.label ?? "");
              setEditing(false);
            }
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.edgeChip}>
      <Text style={styles.edgeArrow}>→</Text>
      <Pressable onPress={() => setEditing(true)} style={styles.edgeMain}>
        <Text style={styles.edgeTarget} numberOfLines={1}>
          {targetLabel}
        </Text>
        {edge.label ? (
          <Text style={styles.edgeLabel} numberOfLines={1}>
            ({edge.label})
          </Text>
        ) : (
          <Text style={styles.edgeLabelPlaceholder}>+ label</Text>
        )}
      </Pressable>
      <Pressable onPress={onRemove} style={styles.edgeRemove} hitSlop={6}>
        <Text style={styles.edgeRemoveText}>✕</Text>
      </Pressable>
    </View>
  );
}

function KindMenu({
  current,
  onPick,
}: {
  current: FlowNodeKind;
  onPick: (kind: FlowNodeKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = nodeKindTone(current);
  return (
    <View style={styles.kindMenuWrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={[styles.miniBtn, { borderColor: tone.fg }]}
      >
        <Text style={[styles.miniBtnText, { color: tone.fg }]}>
          {kindAbbrev(current)} ▾
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.kindMenuPanel}>
          {KINDS.map((k) => {
            const t = nodeKindTone(k);
            return (
              <Pressable
                key={k}
                onPress={() => {
                  setOpen(false);
                  onPick(k);
                }}
                style={styles.kindMenuItem}
              >
                <View style={[styles.kindMenuDot, { backgroundColor: t.fg }]} />
                <Text style={styles.kindMenuLabel}>{kindAbbrev(k)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function EditableText({
  value,
  placeholder,
  onSubmit,
  style,
  singleLine = false,
  multiline = false,
}: {
  value: string;
  placeholder?: string;
  onSubmit: (v: string) => Promise<boolean | undefined>;
  style?: object;
  singleLine?: boolean;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // Sync external value when not editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = async () => {
    setEditing(false);
    if (draft === value) return;
    await onSubmit(draft);
  };

  if (editing) {
    return (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        multiline={multiline}
        onBlur={() => void commit()}
        onSubmitEditing={singleLine ? () => void commit() : undefined}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        style={[style, styles.editableInput]}
        placeholder={placeholder}
        placeholderTextColor={palette.textMuted}
      />
    );
  }

  return (
    <Pressable onPress={() => setEditing(true)} style={styles.editablePress}>
      <Text style={[style, !value && styles.editablePlaceholder]} numberOfLines={multiline ? undefined : 2}>
        {value || placeholder || ""}
      </Text>
    </Pressable>
  );
}

// ===================================================================
// Canvas view (existing absolute drag)
// ===================================================================

function CanvasView({
  flow,
  selectedNodeId,
  edgeSourceId,
  onTapNode,
  onMoveNode,
  onRemoveNode,
  onRemoveEdge,
  onUpdateEdgeLabel,
  onStartWire,
}: {
  flow: Flow | null;
  selectedNodeId: string | null;
  edgeSourceId: string | null;
  onTapNode: (n: FlowNode) => void;
  onMoveNode: (n: FlowNode, x: number, y: number) => Promise<void>;
  onRemoveNode: (n: FlowNode) => Promise<void>;
  onRemoveEdge: (e: FlowEdge) => Promise<void>;
  onUpdateEdgeLabel: (e: FlowEdge, label: string) => Promise<boolean | undefined>;
  onStartWire: (fromId: string) => void;
}) {
  return (
    <ScrollView style={styles.stageScroll} contentContainerStyle={styles.stageContent} horizontal>
      <ScrollView
        contentContainerStyle={{ width: STAGE_W, height: STAGE_H }}
        nestedScrollEnabled
      >
        <View style={[styles.stage, { width: STAGE_W, height: STAGE_H }]}>
          {flow ? (
            <>
              <EdgesLayer
                flow={flow}
                onRemoveEdge={onRemoveEdge}
                onUpdateEdgeLabel={onUpdateEdgeLabel}
              />
              {flow.nodes.map((n) => (
                <NodeCard
                  key={n.id}
                  node={n}
                  selected={selectedNodeId === n.id}
                  edgeMode={edgeSourceId !== null}
                  edgeSource={edgeSourceId === n.id}
                  onTap={() => onTapNode(n)}
                  onDragEnd={(x, y) => void onMoveNode(n, x, y)}
                  onRemove={() => void onRemoveNode(n)}
                  onWire={() => onStartWire(n.id)}
                />
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

// ===================================================================
// SVG edges layer (web)
// ===================================================================

function EdgesLayer({
  flow,
  onRemoveEdge,
  onUpdateEdgeLabel,
}: {
  flow: Flow;
  onRemoveEdge: (e: FlowEdge) => Promise<void>;
  onUpdateEdgeLabel: (e: FlowEdge, label: string) => Promise<boolean | undefined>;
}) {
  const nodeById = useMemo(() => {
    const m = new Map<string, FlowNode>();
    for (const n of flow.nodes) m.set(n.id, n);
    return m;
  }, [flow.nodes]);

  if (Platform.OS !== "web") {
    return (
      <View style={styles.edgesFallback}>
        {flow.edges.map((e) => {
          const a = nodeById.get(e.from_node_id);
          const b = nodeById.get(e.to_node_id);
          return (
            <Pressable
              key={e.id}
              onPress={() => void onRemoveEdge(e)}
              style={styles.edgeFallbackChip}
            >
              <Text style={styles.edgeFallbackText}>
                {a?.label ?? "?"} → {b?.label ?? "?"} {e.label ? `· ${e.label}` : ""} ✕
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <SvgEdges
      flow={flow}
      nodeById={nodeById}
      onRemoveEdge={onRemoveEdge}
      onUpdateEdgeLabel={onUpdateEdgeLabel}
    />
  );
}

function SvgEdges({
  flow,
  nodeById,
  onRemoveEdge,
  onUpdateEdgeLabel,
}: {
  flow: Flow;
  nodeById: Map<string, FlowNode>;
  onRemoveEdge: (e: FlowEdge) => Promise<void>;
  onUpdateEdgeLabel: (e: FlowEdge, label: string) => Promise<boolean | undefined>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editing = flow.edges.find((e) => e.id === editingId) ?? null;

  return (
    <>
      <svg
        width={STAGE_W}
        height={STAGE_H}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={palette.cyan} opacity={0.7} />
          </marker>
        </defs>
        {flow.edges.map((e) => {
          const a = nodeById.get(e.from_node_id);
          const b = nodeById.get(e.to_node_id);
          if (!a || !b) return null;
          const ax = a.x + NODE_W / 2;
          const ay = a.y + NODE_H / 2;
          const bx = b.x + NODE_W / 2;
          const by = b.y + NODE_H / 2;
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          const labelText = e.label ?? "+ label";
          const labelWidth = Math.max(56, labelText.length * 6 + 12);
          return (
            <g key={e.id} style={{ pointerEvents: "auto" }}>
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke={palette.cyan}
                strokeOpacity={0.55}
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              {/* Label (click to edit) */}
              <g
                transform={`translate(${mx - labelWidth / 2}, ${my - 11})`}
                style={{ cursor: "text" }}
                onClick={() => {
                  setDraft(e.label ?? "");
                  setEditingId(e.id);
                }}
              >
                <rect
                  width={labelWidth}
                  height={22}
                  rx={4}
                  fill={palette.bgRaised}
                  stroke={palette.cyan}
                  strokeOpacity={e.label ? 0.55 : 0.25}
                />
                <text
                  x={labelWidth / 2}
                  y={15}
                  fontSize="10"
                  fill={e.label ? palette.cyan : palette.textMuted}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                  style={{ letterSpacing: 0.6 }}
                >
                  {labelText}
                </text>
              </g>
              {/* Delete X (separate small circle just to the right of the label) */}
              <g
                transform={`translate(${mx + labelWidth / 2 + 4}, ${my - 11})`}
                style={{ cursor: "pointer" }}
                onClick={() => void onRemoveEdge(e)}
              >
                <circle
                  cx={11}
                  cy={11}
                  r={9}
                  fill={palette.bgRaised}
                  stroke={palette.danger}
                  strokeOpacity={0.55}
                />
                <text
                  x={11}
                  y={15}
                  fontSize="11"
                  fill={palette.danger}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                >
                  ✕
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      {editing ? (
        <CanvasEdgeLabelEditor
          edge={editing}
          draft={draft}
          setDraft={setDraft}
          onCancel={() => setEditingId(null)}
          onCommit={async () => {
            const next = draft.trim();
            setEditingId(null);
            if ((editing.label ?? "") === next) return;
            await onUpdateEdgeLabel(editing, next);
          }}
          midpoint={(() => {
            const a = nodeById.get(editing.from_node_id);
            const b = nodeById.get(editing.to_node_id);
            if (!a || !b) return { x: 0, y: 0 };
            return {
              x: (a.x + b.x) / 2 + NODE_W / 2,
              y: (a.y + b.y) / 2 + NODE_H / 2,
            };
          })()}
        />
      ) : null}
    </>
  );
}

function CanvasEdgeLabelEditor({
  draft,
  setDraft,
  onCancel,
  onCommit,
  midpoint,
}: {
  edge: FlowEdge;
  draft: string;
  setDraft: (v: string) => void;
  onCancel: () => void;
  onCommit: () => Promise<void>;
  midpoint: { x: number; y: number };
}) {
  return (
    <View
      style={[
        styles.canvasEdgeEditor,
        { left: midpoint.x - 80, top: midpoint.y - 12 },
      ]}
    >
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="label"
        placeholderTextColor={palette.textMuted}
        autoFocus
        onBlur={() => void onCommit()}
        onSubmitEditing={() => void onCommit()}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") onCancel();
        }}
        style={styles.canvasEdgeEditorInput}
      />
    </View>
  );
}

// ===================================================================
// NodeCard (canvas mode)
// ===================================================================

function NodeCard({
  node,
  selected,
  edgeMode,
  edgeSource,
  onTap,
  onDragEnd,
  onRemove,
  onWire,
}: {
  node: FlowNode;
  selected: boolean;
  edgeMode: boolean;
  edgeSource: boolean;
  onTap: () => void;
  onDragEnd: (x: number, y: number) => void;
  onRemove: () => void;
  onWire: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: node.x, y: node.y });

  if (!dragging && (pos.x !== node.x || pos.y !== node.y)) {
    setPos({ x: node.x, y: node.y });
  }

  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    nodeX: number;
    nodeY: number;
  } | null>(null);

  const onPointerDown = (e: {
    clientX: number;
    clientY: number;
    stopPropagation?: () => void;
    preventDefault?: () => void;
    currentTarget?: { setPointerCapture?: (id: number) => void };
    pointerId?: number;
  }) => {
    e.stopPropagation?.();
    e.preventDefault?.();
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      nodeX: pos.x,
      nodeY: pos.y,
    };
    setDragging(true);
    if (e.currentTarget?.setPointerCapture && e.pointerId !== undefined) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    }
  };
  const onPointerMove = (e: { clientX: number; clientY: number }) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    const x = clamp(dragStartRef.current.nodeX + dx, 0, STAGE_W - NODE_W);
    const y = clamp(dragStartRef.current.nodeY + dy, 0, STAGE_H - NODE_H);
    setPos({ x, y });
  };
  const onPointerUp = () => {
    if (!dragStartRef.current) return;
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setDragging(false);
    const moved = Math.abs(pos.x - start.nodeX) > 1 || Math.abs(pos.y - start.nodeY) > 1;
    if (moved) onDragEnd(pos.x, pos.y);
    else onTap();
  };

  // RN-native fallback (used in Canvas view if it ever runs there).
  const lastTouch = useRef<{ x: number; y: number; nodeX: number; nodeY: number } | null>(null);
  const onResponderGrant = (e: GestureResponderEvent) => {
    lastTouch.current = {
      x: e.nativeEvent.pageX,
      y: e.nativeEvent.pageY,
      nodeX: pos.x,
      nodeY: pos.y,
    };
    setDragging(true);
  };
  const onResponderMove = (e: GestureResponderEvent) => {
    if (!lastTouch.current) return;
    const dx = e.nativeEvent.pageX - lastTouch.current.x;
    const dy = e.nativeEvent.pageY - lastTouch.current.y;
    const x = clamp(lastTouch.current.nodeX + dx, 0, STAGE_W - NODE_W);
    const y = clamp(lastTouch.current.nodeY + dy, 0, STAGE_H - NODE_H);
    setPos({ x, y });
  };
  const onResponderRelease = () => {
    if (!lastTouch.current) return;
    const start = lastTouch.current;
    lastTouch.current = null;
    setDragging(false);
    const moved = Math.abs(pos.x - start.nodeX) > 1 || Math.abs(pos.y - start.nodeY) > 1;
    if (moved) onDragEnd(pos.x, pos.y);
    else onTap();
  };

  const tone = nodeKindTone(node.kind);
  const containerStyle = [
    styles.node,
    {
      left: pos.x,
      top: pos.y,
      width: NODE_W,
      height: NODE_H,
      borderColor: edgeSource ? palette.amber : selected ? palette.cyan : tone.border,
      backgroundColor: tone.bg,
    },
    selected && styles.nodeSelected,
    edgeSource && styles.nodeEdgeSource,
    edgeMode && !edgeSource && styles.nodeEdgeTarget,
  ];

  const innerProps =
    Platform.OS === "web"
      ? {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        }
      : {
          onStartShouldSetResponder: () => true,
          onMoveShouldSetResponder: () => true,
          onResponderGrant,
          onResponderMove,
          onResponderRelease,
          onResponderTerminate: onResponderRelease,
        };

  return (
    <View style={containerStyle as never} {...(innerProps as object)}>
      <View style={styles.nodeBody}>
        <Text style={[styles.nodeKind, { color: tone.fg }]}>
          {(node.kind ?? "step").toUpperCase()}
        </Text>
        <Text style={styles.nodeLabel} numberOfLines={2}>
          {node.label}
        </Text>
      </View>
      {selected ? (
        <>
          <Pressable onPress={onWire} style={[styles.nodeAction, styles.nodeWire]}>
            <Text style={styles.nodeWireText}>→</Text>
          </Pressable>
          <Pressable onPress={onRemove} style={[styles.nodeAction, styles.nodeDelete]}>
            <Text style={styles.nodeDeleteText}>✕</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

// ===================================================================
// Advanced add modal (kept as escape hatch for description+kind at create)
// ===================================================================

function NewNodeModal({
  visible,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    label: string;
    kind?: FlowNodeKind;
    description?: string;
  }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FlowNodeKind>("step");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = label.trim().length > 0 && !busy;

  const compact = useCompactLayout();

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await onSubmit({
      label: label.trim(),
      kind,
      description: description.trim() || undefined,
    });
    setBusy(false);
    if (ok) {
      setLabel("");
      setDescription("");
      setKind("step");
    }
  };

  const close = () => {
    onCancel();
    setLabel("");
    setDescription("");
    setKind("step");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={[modalStyles.overlay, compact && compactModalBackdrop]}>
        <View style={[modalStyles.panel, compact && compactModalCard]}>
          <Text style={modalStyles.kicker}>// FLOW NODE</Text>
          <Text style={modalStyles.title}>Add a node</Text>

          <Text style={modalStyles.label}>LABEL</Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Welcome"
            placeholderTextColor={palette.textMuted}
            style={modalStyles.input}
            autoFocus
          />

          <Text style={modalStyles.label}>KIND</Text>
          <View style={modalStyles.kindRow}>
            {KINDS.map((k) => {
              const active = kind === k;
              const tone = nodeKindTone(k);
              return (
                <Pressable
                  key={k}
                  onPress={() => setKind(k)}
                  style={[
                    modalStyles.kindChip,
                    {
                      borderColor: active ? tone.fg : palette.borderSoft,
                      backgroundColor: active ? tone.bg : "transparent",
                    },
                  ]}
                >
                  <Text style={[modalStyles.kindLabel, { color: active ? tone.fg : palette.textSecondary }]}>
                    {k}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={modalStyles.label}>DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What happens at this step?"
            placeholderTextColor={palette.textMuted}
            multiline
            numberOfLines={3}
            style={[modalStyles.input, modalStyles.inputMulti]}
          />

          <View style={modalStyles.actions}>
            <Pressable onPress={close} style={modalStyles.cancelBtn}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={!ready}
              style={[modalStyles.submitBtn, !ready && modalStyles.submitBtnDisabled]}
            >
              <Text style={modalStyles.submitText}>{busy ? "Adding…" : "Add Node"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ===================================================================
// Empty state when no features exist
// ===================================================================

function EmptyFeaturesState() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyKicker}>// FLOW</Text>
      <Text style={styles.emptyTitle}>No features to draft yet</Text>
      <Text style={styles.emptySub}>
        The flow attaches to a feature. Add one on the Features tab (or
        ask the chat) and come back here to lay out the steps.
      </Text>
    </View>
  );
}

// ===================================================================
// Helpers
// ===================================================================

/**
 * Topological order of a flow's nodes.
 *
 * Roots (no incoming edge) come first; cycles fall back to insertion order.
 * Used by the Outline view's numbered list and by Auto-arrange.
 */
function topologicalOrder(flow: Flow): FlowNode[] {
  const incoming = new Map<string, number>();
  for (const n of flow.nodes) incoming.set(n.id, 0);
  for (const e of flow.edges) {
    incoming.set(e.to_node_id, (incoming.get(e.to_node_id) ?? 0) + 1);
  }
  const out: FlowNode[] = [];
  const queue: FlowNode[] = flow.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  // Stable: process in insertion order within each tier.
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const e of flow.edges) {
      if (e.from_node_id !== n.id) continue;
      const remaining = (incoming.get(e.to_node_id) ?? 0) - 1;
      incoming.set(e.to_node_id, remaining);
      if (remaining === 0) {
        const next = flow.nodes.find((m) => m.id === e.to_node_id);
        if (next) queue.push(next);
      }
    }
  }
  // Append any cycle-stuck nodes in insertion order.
  if (out.length < flow.nodes.length) {
    const seen = new Set(out.map((n) => n.id));
    for (const n of flow.nodes) if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

/**
 * Topological grid layout. Assigns x by depth (longest path from a root)
 * and y by sibling order within the depth tier.
 */
function autoArrangePositions(flow: Flow): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const order = topologicalOrder(flow);
  for (const n of order) {
    let d = 0;
    for (const e of flow.edges) {
      if (e.to_node_id !== n.id) continue;
      const pd = depth.get(e.from_node_id);
      if (pd !== undefined) d = Math.max(d, pd + 1);
    }
    depth.set(n.id, d);
  }
  const tiers = new Map<number, FlowNode[]>();
  for (const n of order) {
    const d = depth.get(n.id) ?? 0;
    const arr = tiers.get(d) ?? [];
    arr.push(n);
    tiers.set(d, arr);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, ns] of tiers) {
    ns.forEach((n, i) => {
      positions.set(n.id, { x: AUTO_PAD + d * AUTO_COL, y: AUTO_PAD + i * AUTO_ROW });
    });
  }
  return positions;
}

/**
 * Best-effort post-add edge wiring.
 *
 * Add-flow-node returns the new node id in the mutation result, but the
 * client doesn't have direct access to that — it gets WS-pushed Flow
 * data. We poll the in-memory store for ~1.2s looking for a node whose
 * label matches the one we just added, then fire add_flow_edge.
 */
async function wireAutoEdge(
  ctx: { applyMutation: (env: unknown) => Promise<boolean>; slug: string; featureId: string },
  fromNodeId: string,
  newLabel: string,
): Promise<void> {
  const target = newLabel.trim();
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(100);
    const found = await findRecentNodeByLabel(ctx.slug, ctx.featureId, target);
    if (found && found.id !== fromNodeId) {
      await ctx.applyMutation({
        kind: "add_flow_edge",
        payload: {
          project_slug: ctx.slug,
          feature_id: ctx.featureId,
          from_node_id: fromNodeId,
          to_node_id: found.id,
        },
      });
      return;
    }
  }
}

async function findRecentNodeByLabel(
  slug: string,
  featureId: string,
  label: string,
): Promise<{ id: string } | null> {
  // Lazy-import the store to avoid circular dep on this leaf component.
  const mod = await import("../store");
  const flowsBySlug = mod.useChatStore.getState().flowsBySlug;
  const flow = flowsBySlug[slug]?.find((f) => f.feature_id === featureId);
  if (!flow) return null;
  // Most recent matching node — assume the new one was just appended.
  for (let i = flow.nodes.length - 1; i >= 0; i--) {
    if (flow.nodes[i].label === label) return { id: flow.nodes[i].id };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nodeKindTone(kind?: FlowNodeKind): { fg: string; bg: string; border: string } {
  switch (kind) {
    case "decision":
      return { fg: palette.amber, bg: "rgba(255,180,84,0.06)", border: "rgba(255,180,84,0.32)" };
    case "io":
      return { fg: palette.violet, bg: "rgba(183,139,255,0.06)", border: "rgba(183,139,255,0.34)" };
    case "external":
      return { fg: palette.rose, bg: "rgba(255,107,155,0.06)", border: "rgba(255,107,155,0.34)" };
    case "step":
    default:
      return { fg: palette.cyan, bg: "rgba(15,22,38,0.85)", border: "rgba(92,246,255,0.3)" };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ===================================================================
// Styles
// ===================================================================

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Feature picker
  pickerRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  pickerRowCompact: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  pickerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  pickerChipActive: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.06)",
  },
  pickerDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  pickerLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    maxWidth: 180,
  },
  pickerLabelCompact: { maxWidth: 140 },
  pickerLabelActive: { color: palette.cyan, fontWeight: "700" },
  pickerStatus: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: "700",
  },

  // Toolbar
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgBase,
  },
  toolbarCompact: {
    flexWrap: "wrap",
    alignItems: "flex-start",
    rowGap: space.sm,
    paddingHorizontal: space.md,
  },
  toolbarLeft: { gap: 2, flexShrink: 1 },
  toolbarLabel: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: "600",
  },
  toolbarMeta: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  toolbarRight: { flexDirection: "row", gap: 8, alignItems: "center" },
  toolbarRightCompact: {
    flexWrap: "wrap",
    justifyContent: "flex-end",
    flex: 1,
    width: "100%",
    marginLeft: 0,
  },

  toolBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  toolBtnPressed: { backgroundColor: "rgba(92,246,255,0.06)" },
  toolBtnDisabled: { opacity: 0.4 },
  toolBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },

  modeToggle: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: palette.borderSoft,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  modeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "transparent",
  },
  modeBtnActive: { backgroundColor: "rgba(92,246,255,0.12)" },
  modeText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  modeTextActive: { color: palette.cyan, fontWeight: "700" },

  // Quick-add bar
  quickAddWrap: {
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: palette.bgRaised,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    gap: 6,
  },
  quickAddWrapCompact: {
    paddingHorizontal: space.md,
  },
  quickAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    flexWrap: "wrap",
  },
  quickAddPrefix: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  quickAddInput: {
    flex: 1,
    minWidth: 200,
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    backgroundColor: palette.bgBase,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quickAddInputCompact: {
    minWidth: 120,
  },
  quickAddBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.08)",
    ...glow(palette.cyanGlow, 10),
  },
  quickAddBtnDisabled: { opacity: 0.4 },
  quickAddBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  kindPills: { flexDirection: "row", gap: 4 },
  kindPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  kindPillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: "700",
  },
  fromRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  fromLabel: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  fromName: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 11,
    flexShrink: 1,
  },
  fromClear: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,180,84,0.32)",
  },
  fromClearText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 9 },

  // Wiring banner
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: 6,
    backgroundColor: "rgba(255,180,84,0.08)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,180,84,0.32)",
  },
  bannerText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 11 },
  bannerCancel: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.amber,
  },
  bannerCancelText: { color: palette.amber, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2 },

  // Body layout (main + council rail)
  body: {
    flex: 1,
    flexDirection: "row",
  },
  bodyStacked: {
    flexDirection: "column",
  },
  bodyMain: {
    flex: 1,
    minWidth: 0,
  },
  councilRail: {
    width: 320,
    borderLeftWidth: 1,
    borderLeftColor: palette.borderHair,
  },
  councilRailStacked: {
    width: "100%",
    borderLeftWidth: 0,
    borderTopWidth: 1,
    borderTopColor: palette.borderHair,
  },

  // Outline view
  outlineScroll: { flex: 1, backgroundColor: palette.bgDeep },
  outlineContent: { padding: space.lg, gap: space.sm },
  outlineContentCompact: { padding: space.md, gap: space.sm },
  outlineEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 8,
  },
  outlineEmptyCompact: {
    padding: space.lg,
    paddingHorizontal: space.md,
  },
  outlineEmptyTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: "600",
  },
  outlineEmptySub: {
    color: palette.textSecondary,
    textAlign: "center",
    maxWidth: 480,
    fontSize: 13,
    lineHeight: 20,
  },

  outlineCard: {
    backgroundColor: palette.bgRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderLeftWidth: 3,
    padding: space.md,
    gap: 6,
  },
  outlineCardSelected: {
    borderColor: palette.cyan,
    ...glow(palette.cyanGlow, 14),
  },
  outlineCardWireSource: {
    borderColor: palette.amber,
    ...glow("rgba(255,180,84,0.4)", 14),
  },
  outlineCardWireTarget: {
    backgroundColor: "rgba(255,180,84,0.04)",
  },
  outlineHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  outlineNum: {
    width: 26,
    height: 26,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineNumText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
  },
  outlineKind: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: "700",
    width: 44,
  },
  outlineTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: "600",
  },
  outlineDesc: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
    marginLeft: 36,
  },
  outlineActions: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  outlineEdges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
    marginLeft: 36,
  },

  miniBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  miniBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: "700",
  },
  miniBtnDanger: { borderColor: palette.danger, backgroundColor: "rgba(255,107,107,0.08)" },
  miniBtnDangerText: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: "700",
  },

  // Edge chip (outline)
  edgeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: "rgba(92,246,255,0.32)",
    backgroundColor: "rgba(92,246,255,0.04)",
  },
  edgeChipEditing: { backgroundColor: palette.bgBase },
  edgeArrow: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  edgeMain: { flexDirection: "row", alignItems: "center", gap: 6 },
  edgeTarget: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    maxWidth: 200,
  },
  edgeLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  edgeLabelPlaceholder: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    fontStyle: "italic",
  },
  edgeChipInput: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    minWidth: 80,
    paddingVertical: 0,
  },
  edgeRemove: {
    width: 16,
    height: 16,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,107,107,0.32)",
    marginLeft: 2,
  },
  edgeRemoveText: { color: palette.danger, fontFamily: fonts.mono, fontSize: 9 },

  // Kind menu
  kindMenuWrap: { position: "relative" },
  kindMenuPanel: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    backgroundColor: palette.bgRaised,
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    padding: 4,
    gap: 2,
    zIndex: 10,
    minWidth: 90,
  },
  kindMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radii.sm,
  },
  kindMenuDot: { width: 8, height: 8, borderRadius: 999 },
  kindMenuLabel: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },

  // Inline edit
  editablePress: { flex: 1 },
  editableInput: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    backgroundColor: palette.bgBase,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.cyan,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  editablePlaceholder: { color: palette.textMuted, fontStyle: "italic" },

  // Canvas
  stageScroll: { flex: 1, backgroundColor: palette.bgDeep },
  stageContent: { backgroundColor: palette.bgDeep },
  stage: {
    backgroundColor: palette.bgDeep,
    position: "relative",
    overflow: "hidden",
  },
  edgesFallback: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 8 },
  edgeFallbackChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "rgba(92,246,255,0.32)",
  },
  edgeFallbackText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 10 },

  // Canvas edge editor (web absolute)
  canvasEdgeEditor: {
    position: "absolute",
    width: 160,
    backgroundColor: palette.bgRaised,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.cyan,
    paddingHorizontal: 6,
    paddingVertical: 3,
    ...glow(palette.cyanGlow, 12),
  } as never,
  canvasEdgeEditorInput: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
  },

  // Node card (canvas)
  node: {
    position: "absolute",
    borderRadius: radii.md,
    borderWidth: 1.5,
    overflow: "visible",
    cursor: "grab",
  } as never,
  nodeSelected: { ...glow(palette.cyanGlow, 14) },
  nodeEdgeSource: { ...glow("rgba(255,180,84,0.4)", 14) },
  nodeEdgeTarget: { opacity: 0.85 },
  nodeBody: { flex: 1, padding: 8, justifyContent: "center" },
  nodeKind: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  nodeLabel: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 13,
    marginTop: 2,
  },
  nodeAction: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    backgroundColor: palette.bgRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeWire: {
    top: -8,
    right: 18,
    borderColor: palette.amber,
  },
  nodeWireText: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "700",
  },
  nodeDelete: {
    top: -8,
    right: -8,
    borderColor: palette.danger,
  },
  nodeDeleteText: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
  },

  // Empty wrapper
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 6,
  },
  emptyKicker: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  emptyTitle: { color: palette.textPrimary, fontSize: 20, fontWeight: "600", fontFamily: fonts.body },
  emptySub: {
    color: palette.textSecondary,
    textAlign: "center",
    maxWidth: 480,
    fontSize: 13,
    fontFamily: fonts.body,
    lineHeight: 20,
    marginTop: 4,
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(5,7,13,0.88)",
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  panel: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderHair,
    padding: space.xl,
    gap: space.sm,
    ...glow(palette.cyanGlow, 18),
  },
  kicker: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2.4 },
  title: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 18, fontWeight: "600" },
  label: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.6,
    marginTop: space.sm,
  },
  input: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    backgroundColor: palette.bgBase,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  inputMulti: { minHeight: 70, textAlignVertical: "top" },
  kindRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  kindChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  kindLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: "lowercase" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.md },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  cancelText: { color: palette.textSecondary, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.2 },
  submitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.1)",
    ...glow(palette.cyanGlow, 12),
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitText: { color: palette.cyan, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
});
