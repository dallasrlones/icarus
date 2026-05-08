import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatSummary, ProjectListing, View as AppView } from "../types";
import { fonts, glow, palette, radii, space } from "../theme";
import { UsagePill } from "./UsagePill";
import { VoiceToggle } from "./VoiceToggle";

interface Props {
  view: AppView;
  chats: ChatSummary[];
  activeChatId: string | null;
  projects: ProjectListing[];
  onSelectGlobal: () => void;
  onSelectProject: (slug: string) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onNewProject: () => void;
  /** Phase 22 — current authenticated user (for the footer pill). */
  username?: string | null;
  /** Phase 22 — open the manual change-password flow. */
  onChangePassword?: () => void;
  /** Phase 22 — clear the JWT and return to the login screen. */
  onLogout?: () => void;
}

/**
 * Single sidebar rendering both the project fleet and the chats for the
 * current scope. Mobile-first: collapses to overlay drawer on narrow
 * screens (handled by parent). Order, top to bottom:
 *
 *   - brand
 *   - "+ New chat"
 *   - chat list (for the current scope)
 *   - projects fleet
 *   - "+ New project" footer button
 */
export function Sidebar({
  view,
  chats,
  activeChatId,
  projects,
  onSelectGlobal,
  onSelectProject,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onNewProject,
  username,
  onChangePassword,
  onLogout,
}: Props) {
  const isGlobal = view.kind === "global";
  const activeSlug = view.kind === "project" ? view.slug : null;
  const scopeLabel = isGlobal ? "GLOBAL" : projects.find((p) => p.slug === activeSlug)?.name ?? activeSlug ?? "PROJECT";

  return (
    <View style={styles.sidebar}>
      {/* Header pinned at top — voice + usage stay visible regardless
          of scroll position. Brand row gets the pill stack underneath
          so user-state pills (voice on/off, billing) are immediately
          legible without scrolling. */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>icarus</Text>
          <Text style={styles.brandTag}>// AGENT CONSOLE</Text>
        </View>
        <VoiceToggle />
        <UsagePill />
      </View>

      {/* Single scrollable region for everything below the header.
          We previously tried two independent ScrollViews (one per
          list, both `flex: 1`) but on react-native-web they don't
          measure correctly when the parent's height is implicit
          via flex stretch — children all collapse to ~0 height and
          rows stack on top of each other in the DOM. Using one
          outer ScrollView is more predictable: the whole sidebar
          scrolls as a unit, rows render in normal flow, every
          Pressable is reachable. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <ScopeBar label={scopeLabel} kind={isGlobal ? "global" : "project"} />

        <Pressable
          accessibilityRole="button"
          onPress={onNewChat}
          style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
        >
          <Text style={styles.newBtnPlus}>+</Text>
          <Text style={styles.newBtnText}>NEW CHAT</Text>
        </Pressable>

        <View style={styles.listLabelRow}>
          <Text style={styles.listLabel}>// chats in {isGlobal ? "global" : "project"}</Text>
          <Text style={styles.listCount}>{String(chats.length).padStart(2, "0")}</Text>
        </View>
        <View style={styles.list}>
          {chats.length === 0 ? (
            <Text style={styles.empty}>No chats yet.</Text>
          ) : (
            chats.map((chat) => {
              const active = chat.id === activeChatId;
              return (
                <Pressable
                  key={chat.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat: ${chat.title || "New chat"}`}
                  onPress={() => onSelectChat(chat.id)}
                  style={({ pressed }) => [
                    styles.row,
                    active && styles.rowActive,
                    pressed && !active && styles.rowPressed,
                  ]}
                >
                  <View style={[styles.rowEdge, active && styles.rowEdgeActive]} />
                  <View style={styles.rowMain}>
                    <Text
                      numberOfLines={1}
                      style={[styles.rowTitle, active && styles.rowTitleActive]}
                    >
                      {chat.title || "New chat"}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {String(chat.messageCount).padStart(2, "0")} msgs
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Delete chat"
                    hitSlop={8}
                    onPress={(e) => {
                      e.stopPropagation();
                      onDeleteChat(chat.id);
                    }}
                    style={styles.deleteBtn}
                  >
                    <Text style={styles.deleteBtnText}>×</Text>
                  </Pressable>
                </Pressable>
              );
            })
          )}
        </View>

        <View style={styles.divider} />

        <View style={styles.listLabelRow}>
          <Text style={styles.listLabel}>// projects</Text>
          <Text style={styles.listCount}>{String(projects.length).padStart(2, "0")}</Text>
        </View>
        <View style={styles.list}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Global scope"
            onPress={onSelectGlobal}
            style={({ pressed }) => [
              styles.projectRow,
              isGlobal && styles.projectRowActive,
              pressed && !isGlobal && styles.rowPressed,
            ]}
          >
            <View style={[styles.rowEdge, isGlobal && styles.rowEdgeActive]} />
            <View style={styles.rowMain}>
              <Text
                numberOfLines={1}
                style={[styles.projectTitle, isGlobal && styles.projectTitleActive]}
              >
                ◇ Global
              </Text>
              <Text style={styles.projectMeta}>fleet-wide context</Text>
            </View>
          </Pressable>
          {projects.length === 0 ? (
            <Text style={styles.empty}>No projects yet.</Text>
          ) : (
            projects.map((p) => {
              const active = p.slug === activeSlug;
              return (
                <Pressable
                  key={p.slug}
                  accessibilityRole="button"
                  accessibilityLabel={`Open project: ${p.name}`}
                  onPress={() => onSelectProject(p.slug)}
                  style={({ pressed }) => [
                    styles.projectRow,
                    active && styles.projectRowActive,
                    pressed && !active && styles.rowPressed,
                  ]}
                >
                  <View style={[styles.rowEdge, active && styles.rowEdgeActive]} />
                  <View style={styles.rowMain}>
                    <Text
                      numberOfLines={1}
                      style={[styles.projectTitle, active && styles.projectTitleActive]}
                    >
                      {p.name}
                    </Text>
                    <Text style={styles.projectMeta} numberOfLines={1}>
                      {p.slug}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={onNewProject}
          style={({ pressed }) => [styles.footerBtn, pressed && styles.footerBtnPressed]}
        >
          <Text style={styles.footerBtnPlus}>+</Text>
          <Text style={styles.footerBtnText}>NEW PROJECT</Text>
        </Pressable>

        {username ? (
          <View style={styles.accountBox}>
            <View style={styles.accountRow}>
              <View style={styles.accountDot} />
              <Text style={styles.accountUser} numberOfLines={1}>
                {username}
              </Text>
            </View>
            <View style={styles.accountActions}>
              {onChangePassword ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change password"
                  onPress={onChangePassword}
                  style={({ pressed }) => [styles.accountAction, pressed && styles.accountActionPressed]}
                >
                  <Text style={styles.accountActionText}>change pw</Text>
                </Pressable>
              ) : null}
              {onLogout ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign out"
                  onPress={onLogout}
                  style={({ pressed }) => [styles.accountAction, pressed && styles.accountActionPressed]}
                >
                  <Text style={styles.accountActionText}>sign out</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ScopeBar({ label, kind }: { label: string; kind: "global" | "project" }) {
  return (
    <View style={styles.scopeBar}>
      <View style={[styles.scopeDot, kind === "global" ? styles.scopeDotGlobal : styles.scopeDotProject]} />
      <Text style={styles.scopeLabel}>SCOPE:</Text>
      <Text style={styles.scopeValue} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: 280,
    // Stretch to the parent flex row's full height so the inner
    // ScrollView has a bounded container to scroll inside. Without
    // this the column-flow children fall back to intrinsic height
    // and the ScrollView never engages.
    alignSelf: "stretch",
    flexDirection: "column",
    minHeight: 0,
    backgroundColor: palette.bgRaised,
    borderRightWidth: 1,
    borderRightColor: palette.borderHair,
  },
  header: {
    paddingTop: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
    // Header is the only fixed-height region; everything else
    // scrolls below it. flexShrink: 0 keeps it from collapsing
    // when the scroll content asks for more height than available.
    flexShrink: 0,
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: space.lg },
  // Per-list horizontal inset for chat / project rows. Matches the
  // legacy `chatListContent` / `projectListContent` styles so row
  // alignment under the label rows looks identical to before.
  list: { paddingHorizontal: space.sm },
  brandRow: {
    paddingHorizontal: space.lg,
  },
  brand: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  brandTag: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    marginTop: 2,
  },

  scopeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(8, 11, 22, 0.5)",
  },
  scopeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  scopeDotGlobal: { backgroundColor: palette.cyan, ...glow(palette.cyanGlow, 6) },
  scopeDotProject: { backgroundColor: palette.violet, ...glow("rgba(183,139,255,0.32)", 6) },
  scopeLabel: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.6,
  },
  scopeValue: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    flexShrink: 1,
  },

  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    margin: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: "rgba(92, 246, 255, 0.06)",
    ...glow(palette.cyanGlow, 12),
  },
  newBtnPressed: {
    backgroundColor: "rgba(92, 246, 255, 0.14)",
  },
  newBtnPlus: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  newBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "600",
  },

  listLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 4,
  },
  listLabel: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  listCount: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
  },

  // Both lists are independently-scrollable flex regions sharing
  // the remaining vertical space below the (fixed) header /
  // scopebar / new-chat button and above the (fixed) new-project
  // footer. `flex: 1` on each gives them an equal slice; either
  // can scroll within its own bounds without bleeding into the
  // other or pushing the footer off-screen. This replaces an
  // earlier `maxHeight: 240` on a ScrollView, which didn't clip
  // because the sidebar root had no definite height for max-* to
  // resolve against.
  // (legacy `chatList`/`projectList` styles removed — the lists
  //  are now plain Views inside one outer ScrollView; horizontal
  //  padding is applied via `listLabelRow` for labels and the
  //  per-row paddingHorizontal for items.)

  empty: {
    color: palette.textMuted,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    fontSize: 11,
    fontFamily: fonts.mono,
    fontStyle: "italic",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: radii.md,
    marginBottom: 3,
    gap: 8,
    overflow: "hidden",
  },
  rowActive: { backgroundColor: "rgba(92, 246, 255, 0.06)" },
  rowPressed: { backgroundColor: "rgba(120, 220, 255, 0.04)" },
  rowEdge: { width: 2, alignSelf: "stretch", borderRadius: 1, backgroundColor: "transparent" },
  rowEdgeActive: { backgroundColor: palette.cyan },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 13, fontWeight: "500" },
  rowTitleActive: { color: palette.cyan, fontWeight: "600" },
  rowMeta: { color: palette.textMuted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6, marginTop: 2 },
  deleteBtn: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  deleteBtnText: { color: palette.textMuted, fontSize: 16, lineHeight: 16 },

  divider: {
    height: 1,
    backgroundColor: palette.borderSoft,
    marginVertical: space.sm,
    marginHorizontal: space.lg,
  },

  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: radii.md,
    marginBottom: 3,
    gap: 8,
    overflow: "hidden",
  },
  projectRowActive: { backgroundColor: "rgba(183, 139, 255, 0.08)" },
  projectTitle: { color: palette.textPrimary, fontFamily: fonts.body, fontSize: 13, fontWeight: "500" },
  projectTitleActive: { color: palette.violet, fontWeight: "600" },
  projectMeta: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.4,
    marginTop: 2,
  },

  footerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    margin: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(183, 139, 255, 0.32)",
    backgroundColor: "rgba(183, 139, 255, 0.06)",
  },
  footerBtnPressed: {
    backgroundColor: "rgba(183, 139, 255, 0.14)",
  },
  footerBtnPlus: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  footerBtnText: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "600",
  },

  accountBox: {
    marginHorizontal: space.md,
    marginTop: 0,
    marginBottom: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    backgroundColor: "rgba(8, 11, 22, 0.6)",
    gap: 6,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  accountDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.cyanDim,
  },
  accountUser: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    flex: 1,
  },
  accountActions: {
    flexDirection: "row",
    gap: 6,
  },
  accountAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  accountActionPressed: {
    backgroundColor: "rgba(120, 220, 255, 0.06)",
  },
  accountActionText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
});
