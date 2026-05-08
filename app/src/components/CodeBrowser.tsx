import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as api from "../api";
import type { CodeFile, CodeFileEntry, CodeListing } from "../api";
import { fonts, glow, palette, radii, space } from "../theme";

/**
 * Read-only file browser scoped to the project's `workspace_path`.
 *
 * Two-pane layout: a directory tree on the left (a sequence of expandable
 * sections, one per visited directory) and a viewer on the right. On
 * narrow viewports the panes stack vertically.
 *
 * No syntax highlighting in v1 — monospace text + a small language label.
 * Real prism/shiki highlighting is a future polish.
 */

interface Props {
  slug: string;
  workspacePath?: string;
  /**
   * Mutation pipe used by the "set workspace" empty-state form. Passed
   * straight through from ProjectDetail so the form can emit
   * `update_project { workspace_path }` without a dedicated API.
   */
  applyMutation: (envelope: unknown) => Promise<boolean>;
}

export function CodeBrowser({ slug, workspacePath, applyMutation }: Props) {
  const [listings, setListings] = useState<Map<string, CodeListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<CodeFile | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (rel: string) => {
      try {
        const listing = await api.listFiles(slug, rel);
        setListings((prev) => {
          const next = new Map(prev);
          next.set(rel, listing);
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to list files");
      }
    },
    [slug],
  );

  // Initial root listing.
  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
          if (!listings.has(rel)) void loadDir(rel);
        }
        return next;
      });
    },
    [listings, loadDir],
  );

  const openFile = useCallback(
    async (rel: string) => {
      setSelected(rel);
      setLoadingPath(rel);
      setFile(null);
      try {
        const f = await api.readFile(slug, rel);
        setFile(f);
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to read file");
      } finally {
        setLoadingPath((p) => (p === rel ? null : p));
      }
    },
    [slug],
  );

  if (!workspacePath) {
    return (
      <WorkspaceSetup
        slug={slug}
        onSubmit={async (input) => {
          return await applyMutation({
            kind: "update_project",
            payload: { slug, workspace_path: input },
          });
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      {error ? (
        <Pressable onPress={() => setError(null)} style={styles.errorBanner}>
          <Text style={styles.errorText} numberOfLines={1}>
            {error} (tap to dismiss)
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.split}>
        <ScrollView style={styles.tree} contentContainerStyle={styles.treeContent}>
          <Text style={styles.treeKicker}>// FILE TREE · {workspacePath}</Text>
          <DirNode
            rel=""
            depth={0}
            listings={listings}
            expanded={expanded}
            selected={selected}
            onToggle={toggleDir}
            onOpenFile={(p) => void openFile(p)}
          />
        </ScrollView>

        <View style={styles.viewer}>
          {selected ? (
            <FileViewer file={file} loading={loadingPath === selected} />
          ) : (
            <View style={styles.viewerEmpty}>
              <Text style={styles.viewerEmptyKicker}>// FILE VIEWER</Text>
              <Text style={styles.viewerEmptyTitle}>Pick a file</Text>
              <Text style={styles.viewerEmptySub}>
                Tap a file in the tree to open a read-only view of it.
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Empty-state form for planning-only projects. Lets the user attach a
 * workspace_path right from the Code tab without round-tripping through
 * chat. Two shortcuts:
 *   - "AUTO" → server creates `<WORKSPACE_DIR>/<slug>` and git-inits it
 *     (matches `create_project { workspace_path: "auto" }`).
 *   - typed absolute path → server uses it as-is. This is the host-side
 *     path; for Dockerized installs it must be reachable inside the
 *     server container's WORKSPACE_DIR mount.
 *
 * The form delegates to the parent's `applyMutation` so error handling
 * matches the rest of the app's mutation pipeline.
 */
function WorkspaceSetup({
  slug,
  onSubmit,
}: {
  slug: string;
  onSubmit: (workspacePath: "auto" | string) => Promise<boolean>;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (value: "auto" | string) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ok = await onSubmit(value);
      if (!ok) setErr("server rejected the path — see toast / activity log");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.setupRoot}>
      <View style={styles.setupCard}>
        <Text style={styles.setupKicker}>// CODE TAB</Text>
        <Text style={styles.setupTitle}>This project has no workspace yet</Text>
        <Text style={styles.setupSub}>
          The Code tab needs a folder on disk to read from. Pick one of the
          options below — you can change it later by re-opening this tab on
          a planning-only project.
        </Text>

        <View style={styles.setupSection}>
          <Text style={styles.setupSectionLabel}>OPTION 1 · AUTO</Text>
          <Text style={styles.setupSectionBody}>
            Server creates a fresh folder under{" "}
            <Text style={styles.setupMono}>$WORKSPACE_DIR/{slug}</Text> and
            git-inits it. Best when you don't have an existing repo to point
            at.
          </Text>
          <Pressable
            disabled={busy}
            onPress={() => void submit("auto")}
            style={({ pressed }) => [
              styles.setupBtn,
              styles.setupBtnPrimary,
              pressed && glow(palette.cyan, 12),
              busy && { opacity: 0.45 },
            ]}
          >
            <Text style={styles.setupBtnTextPrimary}>
              {busy ? "CREATING…" : `CREATE $WORKSPACE_DIR/${slug}`}
            </Text>
          </Pressable>
        </View>

        <View style={styles.setupSection}>
          <Text style={styles.setupSectionLabel}>OPTION 2 · EXISTING PATH</Text>
          <Text style={styles.setupSectionBody}>
            Absolute path to a folder the server can read. Inside Docker that
            means a path under the container's mounted WORKSPACE_DIR — by
            default that's <Text style={styles.setupMono}>/workspace/&lt;subdir&gt;</Text>.
          </Text>
          <TextInput
            value={path}
            onChangeText={setPath}
            placeholder="/workspace/my-existing-repo"
            placeholderTextColor={palette.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.setupInput}
          />
          <Pressable
            disabled={busy || path.trim().length === 0}
            onPress={() => void submit(path.trim())}
            style={({ pressed }) => [
              styles.setupBtn,
              styles.setupBtnSecondary,
              (busy || path.trim().length === 0) && { opacity: 0.45 },
              pressed && glow(palette.violet, 12),
            ]}
          >
            <Text style={styles.setupBtnTextSecondary}>
              {busy ? "SETTING…" : "USE THIS PATH"}
            </Text>
          </Pressable>
        </View>

        {err ? <Text style={styles.setupError}>{err}</Text> : null}
      </View>
    </ScrollView>
  );
}

function DirNode({
  rel,
  depth,
  listings,
  expanded,
  selected,
  onToggle,
  onOpenFile,
}: {
  rel: string;
  depth: number;
  listings: Map<string, CodeListing>;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (rel: string) => void;
  onOpenFile: (rel: string) => void;
}) {
  const listing = listings.get(rel);
  const isExpanded = expanded.has(rel);
  const indent = depth * 12;

  if (depth > 0) {
    // Render the row for this dir; the root has no row of its own.
    const name = rel.split("/").filter(Boolean).pop() ?? rel;
    return (
      <View>
        <Pressable
          onPress={() => onToggle(rel)}
          style={({ pressed }) => [
            styles.entryRow,
            { paddingLeft: indent + space.md },
            pressed && styles.entryRowPressed,
          ]}
        >
          <Text style={styles.entryIcon}>{isExpanded ? "▾" : "▸"}</Text>
          <Text style={styles.entryDirName} numberOfLines={1}>
            {name}/
          </Text>
        </Pressable>
        {isExpanded && listing ? (
          <DirChildren
            listing={listing}
            depth={depth + 1}
            listings={listings}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ) : null}
      </View>
    );
  }

  // Root: render children directly.
  if (!listing) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator size="small" color={palette.cyan} />
      </View>
    );
  }
  return (
    <DirChildren
      listing={listing}
      depth={1}
      listings={listings}
      expanded={expanded}
      selected={selected}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
    />
  );
}

function DirChildren({
  listing,
  depth,
  listings,
  expanded,
  selected,
  onToggle,
  onOpenFile,
}: {
  listing: CodeListing;
  depth: number;
  listings: Map<string, CodeListing>;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (rel: string) => void;
  onOpenFile: (rel: string) => void;
}) {
  if (listing.entries.length === 0) {
    return (
      <Text style={[styles.entryRow, { paddingLeft: depth * 12 + space.md, color: palette.textMuted }]}>
        (empty)
      </Text>
    );
  }
  return (
    <View>
      {listing.entries.map((entry) =>
        entry.kind === "dir" ? (
          <DirNode
            key={entry.rel_path}
            rel={entry.rel_path}
            depth={depth}
            listings={listings}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileRow
            key={entry.rel_path}
            entry={entry}
            depth={depth}
            isSelected={entry.rel_path === selected}
            onOpen={() => onOpenFile(entry.rel_path)}
          />
        ),
      )}
    </View>
  );
}

function FileRow({
  entry,
  depth,
  isSelected,
  onOpen,
}: {
  entry: CodeFileEntry;
  depth: number;
  isSelected: boolean;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [
        styles.entryRow,
        { paddingLeft: depth * 12 + space.md },
        pressed && styles.entryRowPressed,
        isSelected && styles.entryRowSelected,
      ]}
    >
      <Text style={styles.entryIcon}>·</Text>
      <Text
        style={[styles.entryFileName, isSelected && styles.entryFileNameSelected]}
        numberOfLines={1}
      >
        {entry.name}
      </Text>
      {entry.size !== undefined && entry.size > 0 ? (
        <Text style={styles.entrySize}>{formatSize(entry.size)}</Text>
      ) : null}
    </Pressable>
  );
}

function FileViewer({ file, loading }: { file: CodeFile | null; loading: boolean }) {
  if (loading) {
    return (
      <View style={styles.viewerEmpty}>
        <ActivityIndicator size="small" color={palette.cyan} />
        <Text style={styles.viewerEmptySub}>loading…</Text>
      </View>
    );
  }
  if (!file) return null;

  if (file.binary) {
    return (
      <View style={styles.viewerEmpty}>
        <Text style={styles.viewerEmptyKicker}>// BINARY</Text>
        <Text style={styles.viewerEmptyTitle}>{file.rel_path}</Text>
        <Text style={styles.viewerEmptySub}>
          {formatSize(file.size)} · binary file (not previewed)
        </Text>
      </View>
    );
  }

  const lines = useMemo(() => (file.text ?? "").split(/\r?\n/), [file.text]);

  return (
    <View style={styles.viewerRoot}>
      <View style={styles.viewerHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.viewerKicker}>// {file.language ?? "plain"}</Text>
          <Text style={styles.viewerPath} numberOfLines={1}>
            {file.rel_path}
          </Text>
        </View>
        <View style={styles.viewerMeta}>
          <Text style={styles.viewerMetaText}>{lines.length} lines</Text>
          <Text style={styles.viewerMetaText}>{formatSize(file.size)}</Text>
          {file.truncated ? <Text style={styles.viewerTruncated}>TRUNCATED</Text> : null}
        </View>
      </View>
      <ScrollView style={styles.codeScroll} contentContainerStyle={styles.codeContent}>
        <View style={styles.codeRows}>
          {lines.map((line, i) => (
            <View key={i} style={styles.codeRow}>
              <Text style={styles.codeLineNo}>{(i + 1).toString().padStart(4, " ")}</Text>
              <Text style={styles.codeLine} selectable>
                {line || " "}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  errorBanner: {
    backgroundColor: palette.dangerDim,
    paddingVertical: 6,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.danger,
  },
  errorText: { color: palette.danger, fontFamily: fonts.mono, fontSize: 11 },

  split: { flex: 1, flexDirection: "row" },
  tree: {
    width: 280,
    borderRightWidth: 1,
    borderRightColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  treeContent: { paddingVertical: space.sm, paddingBottom: space.xxl * 2 },
  treeKicker: {
    color: palette.violetDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },

  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 4,
    paddingRight: space.md,
  },
  entryRowPressed: { backgroundColor: "rgba(92,246,255,0.06)" },
  entryRowSelected: {
    backgroundColor: "rgba(92,246,255,0.1)",
    borderLeftWidth: 2,
    borderLeftColor: palette.cyan,
  },
  entryIcon: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    width: 12,
  },
  entryDirName: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 12,
    flex: 1,
    fontWeight: "600",
  },
  entryFileName: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    flex: 1,
  },
  entryFileNameSelected: { color: palette.cyan, fontWeight: "700" },
  entrySize: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },

  loadingRow: { padding: space.md, alignItems: "flex-start" },

  viewer: { flex: 1, backgroundColor: palette.bgBase },
  viewerEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 6,
  },
  viewerEmptyKicker: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.6,
  },
  viewerEmptyTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: "600",
  },
  viewerEmptySub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 480,
  },

  viewerRoot: { flex: 1 },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderHair,
    backgroundColor: palette.bgRaised,
  },
  viewerKicker: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  viewerPath: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
  },
  viewerMeta: { gap: 2, alignItems: "flex-end" },
  viewerMetaText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  viewerTruncated: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
  },

  codeScroll: { flex: 1 },
  codeContent: { paddingVertical: space.md },
  codeRows: {},
  codeRow: { flexDirection: "row", gap: 12, paddingHorizontal: space.md },
  codeLineNo: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    minWidth: 36,
    textAlign: "right",
  },
  codeLine: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },

  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: 8,
  },
  emptyKicker: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.4,
  },
  emptyTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 20,
    fontWeight: "600",
  },
  emptySub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 460,
    lineHeight: 19,
  },

  setupRoot: {
    padding: space.xl,
    alignItems: "center",
  },
  setupCard: {
    width: "100%",
    maxWidth: 640,
    backgroundColor: palette.bgRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    padding: space.xl,
    gap: space.md,
  },
  setupKicker: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.4,
  },
  setupTitle: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 22,
    fontWeight: "700",
  },
  setupSub: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
  },
  setupSection: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    backgroundColor: palette.bgBase,
    gap: 6,
  },
  setupSectionLabel: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: "700",
  },
  setupSectionBody: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
  },
  setupMono: {
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(80,96,116,0.18)",
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  setupInput: {
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: palette.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 12,
    backgroundColor: palette.bgBase,
    marginTop: 4,
  },
  setupBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginTop: 6,
  },
  setupBtnPrimary: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92,246,255,0.10)",
  },
  setupBtnTextPrimary: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  setupBtnSecondary: {
    borderColor: palette.violet,
    backgroundColor: "rgba(183,139,255,0.10)",
  },
  setupBtnTextSecondary: {
    color: palette.violet,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  setupError: {
    color: palette.danger,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: space.sm,
  },
});
