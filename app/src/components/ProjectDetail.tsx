import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  ActivityEntry,
  Architecture,
  ChatSummary,
  CouncilRun,
  Feature,
  Flow,
  Message,
  Persona,
  Pill,
  ProjectDetail as ProjectDetailType,
  ProjectTab,
  Question,
  ResolvedPersona,
  Rule,
  Task,
  TaskStatus,
} from "../types";
import { ArchitectureCanvas } from "./ArchitectureCanvas";
import { CodeBrowser } from "./CodeBrowser";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { FeaturesTab } from "./FeaturesTab";
import { FlowCanvas } from "./FlowCanvas";
import { QuestionsTab } from "./QuestionsTab";
import { RulesPanel } from "./RulesPanel";
import { PersonasPanel } from "./PersonasPanel";
import { TasksTab } from "./TasksTab";
import { fonts, glow, palette, radii, space } from "../theme";

interface Props {
  detail: ProjectDetailType | null;
  tab: ProjectTab;
  setTab: (t: ProjectTab) => void;

  chats: ChatSummary[];
  activeChatId: string | null;
  messages: Message[];
  streamingText: string;
  streamingPills?: Pill[];
  busy: boolean;

  activity: ActivityEntry[];

  features: Feature[];
  flows: Flow[];
  tasks: Task[];
  selectedFeatureId: string | null;
  onSelectFeature: (id: string | null) => void;
  /**
   * Phase 15 — transient task highlight, set by voice-driven nav
   * (`navigate { kind: "task", task_id }`) and auto-cleared in the
   * store. The Tasks tab renders a glow on the matching card.
   * Optional; pass `null` (or omit) when there's nothing to ping.
   */
  highlightedTaskId?: string | null;
  /** Council runs for the selected feature, if any. */
  councilRuns: CouncilRun[];

  /** All questions for this project (open + answered + dismissed). */
  questions: Question[];
  /**
   * Phase 15.2 — voice loop for Questions. When voice is
   * unavailable (env unset, or native), this is undefined and
   * the SPEAK button on each question card is hidden. When
   * provided, clicking SPEAK reads the question aloud and locks
   * the global voice target so the next confirmed transcript
   * fires `answer_question`.
   */
  onSpeakQuestion?: (question: Question) => void;
  /** Question id currently locked as the voice target. */
  activeVoiceQuestionId?: string | null;

  /** Architecture map (services + edges) for this project. */
  architecture: Architecture | null;

  /** Project-scoped rules (Phase 12). */
  rules: Rule[];

  /** Project-scoped council personas (Phase 14). */
  personas: Persona[];
  /** Resolved lens panel for this project (defaults + globals + project). */
  resolvedPersonas: ResolvedPersona[];

  onArchive: () => void;
  onSend: (text: string) => void;
  applyMutation: (envelope: unknown) => Promise<boolean>;
}

const TABS: { id: ProjectTab; label: string; phase: number }[] = [
  { id: "chat", label: "Chat", phase: 1 },
  { id: "features", label: "Features", phase: 3 },
  { id: "flows", label: "Flows", phase: 3 },
  { id: "tasks", label: "Tasks", phase: 3 },
  { id: "architecture", label: "Architecture", phase: 8 },
  { id: "code", label: "Code", phase: 7 },
  { id: "questions", label: "Questions", phase: 5 },
  { id: "rules", label: "Rules", phase: 12 },
  { id: "personas", label: "Personas", phase: 14 },
  { id: "activity", label: "Activity", phase: 1 },
];

const REAL_TABS = new Set<ProjectTab>([
  "chat",
  "features",
  "flows",
  "tasks",
  "architecture",
  "code",
  "questions",
  "rules",
  "personas",
  "activity",
]);

export function ProjectDetail({
  detail,
  tab,
  setTab,
  chats: _chats,
  activeChatId,
  messages,
  streamingText,
  streamingPills,
  busy,
  activity,
  features,
  flows,
  tasks,
  selectedFeatureId,
  onSelectFeature,
  highlightedTaskId,
  councilRuns,
  questions,
  onSpeakQuestion,
  activeVoiceQuestionId,
  architecture,
  rules,
  personas,
  resolvedPersonas,
  onArchive,
  onSend,
  applyMutation,
}: Props) {
  if (!detail) {
    return (
      <View style={styles.loadingWrap}>
        <Text style={styles.loadingText}>// loading project…</Text>
      </View>
    );
  }
  const { project, counts } = detail;

  return (
    <View style={styles.root}>
      <ProjectHeader
        name={project.name}
        slug={project.slug}
        status={project.status}
        workspacePath={project.workspace_path}
        description={project.description}
        counts={counts}
        onArchive={onArchive}
      />
      <TabBar current={tab} onChange={setTab} />
      <View style={styles.tabBody}>
        {tab === "chat" && (
          <>
            <MessageList
              messages={messages}
              streamingText={streamingText}
              streamingPills={streamingPills}
              busy={busy}
            />
            <Composer disabled={busy || !activeChatId} onSend={onSend} />
          </>
        )}
        {tab === "features" && (
          <FeaturesTab
            slug={project.slug}
            features={features}
            tasks={tasks}
            selectedFeatureId={selectedFeatureId}
            onSelectFeature={(id) => {
              onSelectFeature(id);
              setTab("flows");
            }}
            onArchiveFeature={(id) =>
              void applyMutation({
                kind: "archive_feature",
                payload: { project_slug: project.slug, feature_id: id },
              })
            }
            onAddFeature={(input) =>
              applyMutation({
                kind: "add_feature",
                payload: { project_slug: project.slug, ...input },
              })
            }
            onReplan={(featureId) => {
              // Stale features are in `flowing`; the user has to re-approve
              // the flow before task_planning is allowed. Drop them into
              // the flow canvas with the feature selected — the Council
              // panel exposes Approve / Plan tasks from there.
              onSelectFeature(featureId);
              setTab("flows");
            }}
          />
        )}
        {tab === "flows" && (
          <FlowCanvas
            slug={project.slug}
            features={features}
            flows={flows}
            selectedFeatureId={selectedFeatureId}
            onSelectFeature={onSelectFeature}
            applyMutation={applyMutation}
            councilRuns={councilRuns}
            architecture={architecture}
            resolvedPersonas={resolvedPersonas}
          />
        )}
        {tab === "tasks" && (
          <TasksTab
            slug={project.slug}
            features={features}
            tasks={tasks}
            onAddAdHocTask={(input) =>
              applyMutation({
                kind: "add_task",
                payload: { project_slug: project.slug, ...input },
              })
            }
            onUpdateTaskStatus={async (taskId, status: TaskStatus) => {
              await applyMutation({
                kind: "update_task",
                payload: { project_slug: project.slug, task_id: taskId, status },
              });
            }}
            onArchiveTask={async (taskId) => {
              await applyMutation({
                kind: "archive_task",
                payload: { project_slug: project.slug, task_id: taskId },
              });
            }}
            onApproveTasks={async (featureId, taskIds) => {
              await applyMutation({
                kind: "approve_tasks",
                payload: { project_slug: project.slug, feature_id: featureId, task_ids: taskIds },
              });
            }}
            onRunTask={async (taskId) => {
              await applyMutation({
                kind: "start_task",
                payload: { project_slug: project.slug, task_id: taskId },
              });
            }}
            highlightedTaskId={highlightedTaskId ?? null}
          />
        )}
        {tab === "architecture" && (
          <ArchitectureCanvas
            slug={project.slug}
            architecture={architecture}
            applyMutation={applyMutation}
          />
        )}
        {tab === "code" && (
          <CodeBrowser
            slug={project.slug}
            workspacePath={project.workspace_path}
            applyMutation={applyMutation}
          />
        )}
        {tab === "questions" && (
          <QuestionsTab
            questions={questions}
            tasks={tasks}
            onAnswer={async (questionId, answer, choice) => {
              await applyMutation({
                kind: "answer_question",
                payload: { project_slug: project.slug, question_id: questionId, answer, choice },
              });
            }}
            onDismiss={async (questionId) => {
              await applyMutation({
                kind: "dismiss_question",
                payload: { project_slug: project.slug, question_id: questionId },
              });
            }}
            onSpeakQuestion={onSpeakQuestion}
            activeVoiceQuestionId={activeVoiceQuestionId}
          />
        )}
        {tab === "rules" && (
          <RulesPanel
            rules={rules}
            scope={{ kind: "project", slug: project.slug }}
            onApply={applyMutation}
          />
        )}
        {tab === "personas" && (
          <PersonasPanel
            personas={personas}
            resolved={resolvedPersonas}
            scope={{ kind: "project", slug: project.slug }}
            onApply={applyMutation}
          />
        )}
        {tab === "activity" && <ActivityFeed entries={activity} />}
        {!REAL_TABS.has(tab) && <PhasePlaceholder tab={tab} />}
      </View>
    </View>
  );
}

function ProjectHeader({
  name,
  slug,
  status,
  workspacePath,
  description,
  counts,
  onArchive,
}: {
  name: string;
  slug: string;
  status: string;
  workspacePath?: string;
  description?: string;
  counts: { features: number; tasks: number; flows: number };
  onArchive: () => void;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerLabel}>// project</Text>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {name}
          </Text>
          <View style={styles.headerMeta}>
            <Text style={styles.headerSlug}>{slug}</Text>
            <View style={styles.metaDivider} />
            <View
              style={[
                styles.statusPill,
                status === "archived" ? styles.statusPillArchived : styles.statusPillActive,
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  status === "archived" ? styles.statusTextArchived : styles.statusTextActive,
                ]}
              >
                {status.toUpperCase()}
              </Text>
            </View>
          </View>
        </View>
        <Pressable
          onPress={onArchive}
          style={({ pressed }) => [styles.archiveBtn, pressed && styles.archiveBtnPressed]}
        >
          <Text style={styles.archiveBtnText}>ARCHIVE</Text>
        </Pressable>
      </View>
      {description ? <Text style={styles.headerDesc}>{description}</Text> : null}
      <View style={styles.headerStrip}>
        <Stat label="WORKSPACE" value={workspacePath ?? "(planning-only)"} mono />
        <Stat label="FEATURES" value={String(counts.features)} mono />
        <Stat label="TASKS" value={String(counts.tasks)} mono />
        <Stat label="FLOWS" value={String(counts.flows)} mono />
      </View>
    </View>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        style={[styles.statValue, mono && styles.statValueMono]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function TabBar({ current, onChange }: { current: ProjectTab; onChange: (t: ProjectTab) => void }) {
  return (
    <View style={styles.tabBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBarContent}
      >
        {TABS.map((t) => {
          const active = t.id === current;
          const real = REAL_TABS.has(t.id);
          return (
            <Pressable
              key={t.id}
              onPress={() => onChange(t.id)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {t.label}
              </Text>
              {!real && <Text style={styles.tabSoon}>· P{t.phase}</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function PhasePlaceholder({ tab }: { tab: ProjectTab }) {
  const phase = TABS.find((t) => t.id === tab)?.phase ?? 0;
  return (
    <View style={styles.placeholderWrap}>
      <Text style={styles.placeholderKicker}>// PHASE {phase}</Text>
      <Text style={styles.placeholderTitle}>{titleFor(tab)} — coming soon</Text>
      <Text style={styles.placeholderSub}>{subFor(tab)}</Text>
    </View>
  );
}

function titleFor(tab: ProjectTab): string {
  switch (tab) {
    case "tasks": return "Task Kanban";
    case "features": return "Features list";
    case "flows": return "Flow canvas";
    case "code": return "Code browser";
    case "questions": return "Questions inbox";
    case "rules": return "Project rules";
    case "personas": return "Council personas";
    default: return "Soon";
  }
}

function subFor(tab: ProjectTab): string {
  switch (tab) {
    case "tasks": return "Drag-on-web / tap-on-mobile Kanban with stale-task badges. Lifecycle-gated by feature flow approval.";
    case "features": return "Feature cards with lifecycle states (draft → flowing → flow_review → flow_approved → planning → planned → in_progress → done).";
    case "flows": return "Per-feature node/edge canvas. Council-flavored chat drafts; formal council pass at the approval gate.";
    case "code": return "File tree of the project's workspace_path with read-only viewer + live diff highlighting when the queue worker is editing.";
    case "questions": return "Open questions raised by agents during task execution. Reply inline or jump to the originating chat.";
    case "rules": return "Project-scoped guidance prepended to every cursor-agent run inside this project — chat, queue, council, tools.";
    case "personas": return "Project-scoped council lenses. Replace a default lens or add a new one (e.g. marketing, legal) for this project's flow reviews.";
    default: return "";
  }
}

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <View style={styles.placeholderWrap}>
        <Text style={styles.placeholderKicker}>// ACTIVITY</Text>
        <Text style={styles.placeholderTitle}>No mutations yet</Text>
        <Text style={styles.placeholderSub}>
          Every applied mutation lands here append-only. Create a feature or
          run a tool and the trail will start filling in.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.activity} contentContainerStyle={styles.activityContent}>
      {entries
        .slice()
        .reverse()
        .map((e, i) => (
          <View key={`${e.ts}-${i}`} style={styles.activityRow}>
            <View style={styles.activityEdge} />
            <View style={styles.activityBody}>
              <View style={styles.activityHeadRow}>
                <Text style={styles.activityKind}>{e.kind}</Text>
                <Text style={styles.activityTs}>{formatTs(e.ts)}</Text>
              </View>
              <Text style={styles.activityPayload} numberOfLines={3}>
                {summarize(e)}
              </Text>
            </View>
          </View>
        ))}
    </ScrollView>
  );
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function summarize(e: ActivityEntry): string {
  try {
    const p = JSON.stringify(e.payload);
    return p.length > 200 ? `${p.slice(0, 200)}…` : p;
  } catch {
    return "(payload not serializable)";
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 12 },

  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
    gap: space.sm,
  },
  headerTop: { flexDirection: "row", alignItems: "flex-start", gap: space.lg },
  headerLeft: { flex: 1, minWidth: 0 },
  headerLabel: {
    color: palette.violetDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  headerTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 0.3,
    marginTop: 2,
  },
  headerMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  headerSlug: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  metaDivider: {
    width: 1,
    height: 12,
    backgroundColor: palette.borderHair,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  statusPillActive: {
    borderColor: palette.green,
    backgroundColor: "rgba(118, 245, 176, 0.08)",
  },
  statusPillArchived: {
    borderColor: palette.textMuted,
    backgroundColor: "rgba(80, 96, 116, 0.18)",
  },
  statusText: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4, fontWeight: "600" },
  statusTextActive: { color: palette.green },
  statusTextArchived: { color: palette.textSecondary },

  archiveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  archiveBtnPressed: {
    backgroundColor: "rgba(255, 107, 107, 0.08)",
    borderColor: "rgba(255, 107, 107, 0.4)",
  },
  archiveBtnText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },

  headerDesc: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  headerStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.lg,
    marginTop: 4,
  },
  stat: { gap: 2, minWidth: 80 },
  statLabel: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.5,
  },
  statValue: { color: palette.textPrimary, fontSize: 13, fontFamily: fonts.body, fontWeight: "500" },
  statValueMono: { fontFamily: fonts.mono, fontSize: 11 },

  tabBar: {
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgBase,
  },
  tabBarContent: { paddingHorizontal: space.lg },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: palette.cyan,
    ...glow(palette.cyanGlow, 6),
  },
  tabLabel: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: "500",
  },
  tabLabelActive: { color: palette.cyan, fontWeight: "700" },
  tabSoon: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6 },

  tabBody: { flex: 1 },

  placeholderWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 6,
  },
  placeholderKicker: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.4,
  },
  placeholderTitle: {
    color: palette.textPrimary,
    fontSize: 20,
    fontWeight: "600",
    fontFamily: fonts.body,
    letterSpacing: 0.2,
  },
  placeholderSub: {
    color: palette.textSecondary,
    textAlign: "center",
    maxWidth: 480,
    fontSize: 13,
    fontFamily: fonts.body,
    lineHeight: 20,
    marginTop: 4,
  },

  activity: { flex: 1 },
  activityContent: { padding: space.lg, gap: space.sm },
  activityRow: {
    flexDirection: "row",
    backgroundColor: "rgba(15, 22, 38, 0.55)",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    overflow: "hidden",
  },
  activityEdge: { width: 2, backgroundColor: palette.violet, alignSelf: "stretch" },
  activityBody: { flex: 1, padding: space.md, gap: 4, minWidth: 0 },
  activityHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  activityKind: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.6,
  },
  activityTs: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.4,
  },
  activityPayload: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
  },
});
