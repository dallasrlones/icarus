import { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavMenuButton } from "./src/components/NavMenuButton";
import { Sidebar } from "./src/components/Sidebar";
import { Composer } from "./src/components/Composer";
import { MessageList } from "./src/components/MessageList";
import { ProjectDetail } from "./src/components/ProjectDetail";
import { NewProjectModal } from "./src/components/NewProjectModal";
import { QueueTicker } from "./src/components/QueueTicker";
import { ToolsPanel } from "./src/components/ToolsPanel";
import { CronPanel } from "./src/components/CronPanel";
import { RulesPanel } from "./src/components/RulesPanel";
import { PersonasPanel } from "./src/components/PersonasPanel";
import { SettingsPanel } from "./src/components/SettingsPanel";
import { AuthScreen } from "./src/components/AuthScreen";
import { VoiceButton } from "./src/components/VoiceButton";
import { useChatStore } from "./src/store";
import { fonts, hudGrid, palette, radii, space } from "./src/theme";
import { useCompactLayout } from "./src/layout/compact";
import { scopeKey, type ChatScope, type GlobalTab } from "./src/types";
import {
  type AuthUser,
  getCurrentUser,
  isAuthenticated,
  logout,
  refreshMe,
  subscribeAuth,
} from "./src/auth";

const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap";

function labelForGlobalTab(t: GlobalTab): string {
  switch (t) {
    case "chat":
      return "CHAT";
    case "tools":
      return "TOOLS";
    case "cron":
      return "CRON";
    case "rules":
      return "RULES";
    case "personas":
      return "PERSONAS";
    case "settings":
      return "SETTINGS";
  }
}

function ensureWebFontsLoaded(): void {
  if (Platform.OS !== "web") return;
  const id = "icarus-google-fonts";
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = GOOGLE_FONTS_HREF;
  document.head.appendChild(link);
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(() => getCurrentUser());
  const [authReady, setAuthReady] = useState<boolean>(() => !isAuthenticated());
  const [forcingChange, setForcingChange] = useState<boolean>(false);
  const [voluntaryChange, setVoluntaryChange] = useState<boolean>(false);

  // Whenever the token comes/goes (login, logout, 401, mid-session
  // password change), keep our auth-gate state in lockstep with the
  // auth module's source of truth.
  useEffect(() => {
    return subscribeAuth((auth) => {
      setUser(auth?.user ?? null);
      if (!auth) {
        setForcingChange(false);
        setVoluntaryChange(false);
      } else {
        setForcingChange(auth.user.must_change_password);
      }
    });
  }, []);

  useEffect(() => {
    ensureWebFontsLoaded();
  }, []);

  // First boot when we already had a token cached: validate it
  // against `/v1/auth/me`. If the token is stale (server rotated,
  // user deleted, etc.) the helper drops it and we end up on the
  // login screen via `subscribeAuth` above.
  useEffect(() => {
    if (!isAuthenticated()) {
      setAuthReady(true);
      return;
    }
    let cancelled = false;
    void refreshMe().finally(() => {
      if (!cancelled) setAuthReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <View style={[styles.shell, hudGrid as object]} />
      </SafeAreaView>
    );
  }

  if (!user) {
    return <AuthScreen mode={{ kind: "login" }} onAuthChanged={(u) => setUser(u)} />;
  }

  if (forcingChange || voluntaryChange) {
    return (
      <AuthScreen
        mode={{
          kind: "change",
          user,
          forced: forcingChange,
          onCancel: voluntaryChange && !forcingChange ? () => setVoluntaryChange(false) : undefined,
        }}
        onAuthChanged={(u) => {
          setUser(u);
          if (u && !u.must_change_password) {
            setForcingChange(false);
            setVoluntaryChange(false);
          }
        }}
      />
    );
  }

  return <MainShell user={user} onRequestPasswordChange={() => setVoluntaryChange(true)} />;
}

interface MainShellProps {
  user: AuthUser;
  onRequestPasswordChange: () => void;
}

function MainShell({ user, onRequestPasswordChange }: MainShellProps) {
  const view = useChatStore((s) => s.view);
  const projects = useChatStore((s) => s.projects);
  const projectDetailBySlug = useChatStore((s) => s.projectDetailBySlug);
  const chatsByScope = useChatStore((s) => s.chatsByScope);
  const activeChatByScope = useChatStore((s) => s.activeChatByScope);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const streamingByChat = useChatStore((s) => s.streamingByChat);
  const streamingPillsByChat = useChatStore((s) => s.streamingPillsByChat);
  const busyByChat = useChatStore((s) => s.busyByChat);
  const activityByScope = useChatStore((s) => s.activityByScope);
  const featuresBySlug = useChatStore((s) => s.featuresBySlug);
  const flowsBySlug = useChatStore((s) => s.flowsBySlug);
  const tasksBySlug = useChatStore((s) => s.tasksBySlug);
  const selectedFeatureBySlug = useChatStore((s) => s.selectedFeatureBySlug);
  const highlightedTaskBySlug = useChatStore((s) => s.highlightedTaskBySlug);
  const councilRunsByFeature = useChatStore((s) => s.councilRunsByFeature);
  const queue = useChatStore((s) => s.queue);
  const runningTaskTail = useChatStore((s) => s.runningTaskTail);
  const questionsBySlug = useChatStore((s) => s.questionsBySlug);
  const architectureBySlug = useChatStore((s) => s.architectureBySlug);
  const tools = useChatStore((s) => s.tools);
  const cronJobs = useChatStore((s) => s.cronJobs);
  const globalRules = useChatStore((s) => s.globalRules);
  const rulesBySlug = useChatStore((s) => s.rulesBySlug);
  const toolProposals = useChatStore((s) => s.toolProposals);
  const globalPersonas = useChatStore((s) => s.globalPersonas);
  const personasBySlug = useChatStore((s) => s.personasBySlug);
  const resolvedPersonasBySlug = useChatStore((s) => s.resolvedPersonasBySlug);
  const models = useChatStore((s) => s.models);
  const error = useChatStore((s) => s.error);

  const refreshChats = useChatStore((s) => s.refreshChats);
  const refreshProjects = useChatStore((s) => s.refreshProjects);
  const selectGlobal = useChatStore((s) => s.selectGlobal);
  const setGlobalTab = useChatStore((s) => s.setGlobalTab);
  const selectProject = useChatStore((s) => s.selectProject);
  const setProjectTab = useChatStore((s) => s.setProjectTab);
  const selectChat = useChatStore((s) => s.selectChat);
  const newChat = useChatStore((s) => s.newChat);
  const removeChat = useChatStore((s) => s.removeChat);
  const send = useChatStore((s) => s.send);
  const createProject = useChatStore((s) => s.createProject);
  const archiveProject = useChatStore((s) => s.archiveProject);
  const selectFeature = useChatStore((s) => s.selectFeature);
  const applyAndRefresh = useChatStore((s) => s.applyAndRefresh);
  const speakQuestion = useChatStore((s) => s.speakQuestion);
  const voiceTarget = useChatStore((s) => s.voice.target);
  const voiceAvailable = useChatStore((s) => s.voice.available);

  const compact = useCompactLayout();
  const { width: windowWidth } = useWindowDimensions();
  const [navOpen, setNavOpen] = useState(false);
  const drawerWidth = Math.min(Math.round(windowWidth * 0.88), 300);

  const [newProjectVisible, setNewProjectVisible] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  useEffect(() => {
    ensureWebFontsLoaded();
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void refreshChats();
  }, [view, refreshChats]);

  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  const scope: ChatScope = view.kind === "global"
    ? { kind: "global" }
    : { kind: "project", slug: view.slug };
  const key = scopeKey(scope);
  const globalTab: GlobalTab = view.kind === "global" ? view.tab : "chat";

  const chats = chatsByScope[key] ?? [];
  const activeChatId = activeChatByScope[key] ?? null;

  const messages = activeChatId ? messagesByChat[activeChatId] ?? [] : [];
  const streamingText = activeChatId ? streamingByChat[activeChatId] ?? "" : "";
  const streamingPills = activeChatId ? streamingPillsByChat[activeChatId] ?? [] : [];
  const busy = activeChatId ? busyByChat[activeChatId] ?? false : false;

  const projectDetail =
    view.kind === "project" ? projectDetailBySlug[view.slug] ?? null : null;
  const projectActivity =
    view.kind === "project" ? activityByScope[key] ?? [] : [];
  const projectFeatures =
    view.kind === "project" ? featuresBySlug[view.slug] ?? [] : [];
  const projectFlows =
    view.kind === "project" ? flowsBySlug[view.slug] ?? [] : [];
  const projectTasks =
    view.kind === "project" ? tasksBySlug[view.slug] ?? [] : [];
  const projectSelectedFeature =
    view.kind === "project" ? selectedFeatureBySlug[view.slug] ?? null : null;
  const projectHighlightedTask =
    view.kind === "project" ? highlightedTaskBySlug[view.slug] ?? null : null;
  const projectCouncilRuns =
    view.kind === "project" && projectSelectedFeature
      ? councilRunsByFeature[`${view.slug}::${projectSelectedFeature}`] ?? []
      : [];
  const projectQuestions =
    view.kind === "project" ? questionsBySlug[view.slug] ?? [] : [];
  const projectArchitecture =
    view.kind === "project" ? architectureBySlug[view.slug] ?? null : null;
  const projectRules =
    view.kind === "project" ? rulesBySlug[view.slug] ?? [] : [];
  const projectPersonas =
    view.kind === "project" ? personasBySlug[view.slug] ?? [] : [];
  const projectResolvedPersonas =
    view.kind === "project" ? resolvedPersonasBySlug[view.slug] ?? [] : [];

  const browserTabTitle =
    view.kind === "global"
      ? "Icarus"
      : projectDetail?.project.name ??
        projects.find((p) => p.slug === view.slug)?.name ??
        view.slug;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.title = browserTabTitle;
  }, [browserTabTitle]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    return () => {
      document.title = "Icarus";
    };
  }, []);

  const sidebarProps = {
    view,
    chats,
    activeChatId,
    projects,
    onSelectGlobal: () => selectGlobal(),
    onSelectProject: (slug: string) => void selectProject(slug),
    onSelectChat: (id: string) => void selectChat(id),
    onNewChat: () => void newChat(),
    onDeleteChat: (id: string) => void removeChat(id),
    onNewProject: () => setNewProjectVisible(true),
    username: user.username,
    onChangePassword: onRequestPasswordChange,
    onLogout: () => void logout(),
  };

  const globalTabButtons = (["chat", "tools", "cron", "rules", "personas", "settings"] as const).map((t) => {
    const active = globalTab === t;
    const pendingCount =
      t === "tools"
        ? toolProposals.filter((p) => p.status === "pending").length
        : 0;
    return (
      <Pressable
        key={t}
        onPress={() => setGlobalTab(t)}
        style={[styles.globalTab, active && styles.globalTabActive]}
      >
        <Text style={[styles.globalTabText, active && styles.globalTabTextActive]}>
          {labelForGlobalTab(t)}
        </Text>
        {pendingCount > 0 ? (
          <View style={styles.globalTabBadge}>
            <Text style={styles.globalTabBadgeText}>{pendingCount}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  });

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={[styles.shell, hudGrid as object]}>
        {!compact ? <Sidebar {...sidebarProps} variant="inline" /> : null}
        <View style={[styles.main, compact && styles.mainCompact]}>
          {error && (
            <Pressable
              onPress={() => useChatStore.setState({ error: null })}
              style={styles.errorBanner}
            >
              <Text style={styles.errorText} numberOfLines={2}>
                {error} (tap to dismiss)
              </Text>
            </Pressable>
          )}

          {view.kind === "global" ? (
            <>
              <View style={[styles.topbar, compact && styles.topbarCompact]}>
                <View style={[styles.topbarMainRow, compact && styles.topbarMainRowCompact]}>
                  {compact ? (
                    <NavMenuButton onPress={() => setNavOpen(true)} />
                  ) : null}
                  <View style={[styles.topbarLeft, compact && styles.topbarLeftCompact]}>
                    <Text style={styles.topbarLabel}>// global cockpit</Text>
                    <Text style={styles.topbarTitle} numberOfLines={1}>
                      {globalTab === "chat"
                        ? chats.find((c) => c.id === activeChatId)?.title ?? "Chat"
                        : globalTab === "tools"
                          ? "Tools"
                          : globalTab === "cron"
                            ? "Cron"
                            : globalTab === "rules"
                              ? "Rules"
                              : globalTab === "personas"
                                ? "Personas"
                                : "Settings"}
                    </Text>
                  </View>
                  {!compact ? (
                    <View style={styles.globalTabs}>{globalTabButtons}</View>
                  ) : null}
                </View>
                {compact ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.globalTabsScrollInner}
                  >
                    {globalTabButtons}
                  </ScrollView>
                ) : null}
              </View>
              {globalTab === "chat" ? (
                <>
                  <MessageList
                    messages={messages}
                    streamingText={streamingText}
                    streamingPills={streamingPills}
                    busy={busy}
                  />
                  <Composer disabled={busy || !activeChatId} onSend={(text) => void send(text)} />
                </>
              ) : globalTab === "tools" ? (
                <ToolsPanel
                  tools={tools}
                  projects={projects}
                  proposals={toolProposals}
                  onApply={(envelope) => applyAndRefresh(envelope)}
                />
              ) : globalTab === "cron" ? (
                <CronPanel
                  jobs={cronJobs}
                  tools={tools}
                  projects={projects}
                  onApply={(envelope) => applyAndRefresh(envelope)}
                />
              ) : globalTab === "rules" ? (
                <RulesPanel
                  rules={globalRules}
                  scope={{ kind: "global" }}
                  onApply={(envelope) => applyAndRefresh(envelope)}
                />
              ) : globalTab === "personas" ? (
                <PersonasPanel
                  personas={globalPersonas}
                  resolved={resolvedPersonasBySlug["__global"] ?? []}
                  scope={{ kind: "global" }}
                  onApply={(envelope) => applyAndRefresh(envelope)}
                />
              ) : (
                <SettingsPanel
                  models={models}
                  onApply={(envelope) => applyAndRefresh(envelope)}
                />
              )}
            </>
          ) : (
            <ProjectDetail
              compact={compact}
              onOpenNav={() => setNavOpen(true)}
              detail={projectDetail}
              tab={view.tab}
              setTab={setProjectTab}
              chats={chats}
              activeChatId={activeChatId}
              messages={messages}
              streamingText={streamingText}
              streamingPills={streamingPills}
              busy={busy}
              activity={projectActivity}
              features={projectFeatures}
              flows={projectFlows}
              tasks={projectTasks}
              selectedFeatureId={projectSelectedFeature}
              onSelectFeature={(id) => selectFeature(view.slug, id)}
              highlightedTaskId={projectHighlightedTask}
              councilRuns={projectCouncilRuns}
              questions={projectQuestions}
              onSpeakQuestion={voiceAvailable ? speakQuestion : undefined}
              activeVoiceQuestionId={
                voiceTarget.kind === "question" &&
                voiceTarget.project_slug === view.slug
                  ? voiceTarget.question_id
                  : null
              }
              architecture={projectArchitecture}
              rules={projectRules}
              personas={projectPersonas}
              resolvedPersonas={projectResolvedPersonas}
              onArchive={() => void archiveProject(view.slug)}
              onSend={(text) => void send(text)}
              applyMutation={(envelope) => applyAndRefresh(envelope, view.slug)}
            />
          )}
          <QueueTicker
            queue={queue}
            runningTail={runningTaskTail}
            projects={projects}
            onStart={(slug) =>
              void applyAndRefresh({
                kind: "start_queue",
                payload: slug ? { project_slug: slug } : {},
              })
            }
            onPause={() =>
              void applyAndRefresh({ kind: "pause_queue", payload: {} })
            }
            onStop={() =>
              void applyAndRefresh({ kind: "stop_queue", payload: {} })
            }
          />
        </View>
      </View>

      {compact ? (
        <Modal
          visible={navOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setNavOpen(false)}
        >
          <View style={styles.drawerRoot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close navigation menu"
              style={styles.drawerBackdrop}
              onPress={() => setNavOpen(false)}
            />
            <View style={[styles.drawerPanel, { width: drawerWidth }]}>
              <Sidebar
                {...sidebarProps}
                variant="drawer"
                onRequestClose={() => setNavOpen(false)}
              />
            </View>
          </View>
        </Modal>
      ) : null}

      <VoiceButton />

      <NewProjectModal
        visible={newProjectVisible}
        busy={creatingProject}
        onCancel={() => setNewProjectVisible(false)}
        onSubmit={async (input) => {
          setCreatingProject(true);
          const created = await createProject(input);
          setCreatingProject(false);
          if (created) {
            setNewProjectVisible(false);
            void selectProject(created.slug);
          }
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bgDeep },
  shell: { flex: 1, flexDirection: "row", backgroundColor: palette.bgDeep },
  main: { flex: 1, backgroundColor: palette.bgBase },
  mainCompact: { minWidth: 0 },
  drawerRoot: { flex: 1, flexDirection: "row" },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.52)",
  },
  drawerPanel: {
    flexShrink: 0,
    alignSelf: "stretch",
    maxHeight: "100%",
    backgroundColor: palette.bgRaised,
    borderLeftWidth: 1,
    borderLeftColor: palette.borderHair,
    ...Platform.select({
      web: {
        boxShadow: "-10px 0 32px rgba(0,0,0,0.45)",
      },
      default: {},
    }),
  },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  topbarCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  topbarMainRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  topbarMainRowCompact: { justifyContent: "flex-start" },
  topbarLeft: { flexShrink: 1, gap: 2 },
  topbarLeftCompact: { flex: 1, minWidth: 0 },
  globalTabsScrollInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingRight: space.md,
  },
  topbarLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  topbarTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  topbarSub: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  globalTabs: {
    flexDirection: "row",
    gap: 4,
  },
  globalTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  globalTabActive: {
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92,246,255,0.08)",
  },
  globalTabText: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  globalTabTextActive: { color: palette.cyan },
  globalTabBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: palette.violet,
    alignItems: "center",
    justifyContent: "center",
  },
  globalTabBadgeText: {
    color: palette.textInverse,
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
  },
  errorBanner: {
    backgroundColor: palette.dangerDim,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.danger,
  },
  errorText: { color: palette.danger, fontSize: 13, fontFamily: fonts.mono },
});
