import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { Message, Pill } from "../types";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { PillRow } from "./PillRow";
import { useScreenEdgePadding, useCompactLayout } from "../layout/compact";
import { fonts, palette, radii, space } from "../theme";

interface Props {
  messages: Message[];
  streamingText: string;
  streamingPills?: Pill[];
  busy: boolean;
}

export function MessageList({ messages, streamingText, streamingPills, busy }: Props) {
  const ref = useRef<ScrollView>(null);
  const pillCount = streamingPills?.length ?? 0;
  const edgePad = useScreenEdgePadding();
  const compact = useCompactLayout();

  useEffect(() => {
    ref.current?.scrollToEnd({ animated: true });
  }, [messages.length, streamingText, pillCount]);

  if (messages.length === 0 && !busy) {
    return (
      <View style={[styles.emptyWrap, { paddingHorizontal: edgePad }]}>
        <Text style={styles.emptyKicker}>// READY</Text>
        <Text style={styles.emptyTitle}>Awaiting input</Text>
        <Text style={styles.emptySub}>
          Ask icarus anything. The agent will respond, remember the thread,
          and emit `icarus` action blocks when you ask it to change state.
        </Text>
      </View>
    );
  }

  const showStreaming = busy || streamingText.length > 0 || (streamingPills?.length ?? 0) > 0;

  return (
    <ScrollView
      ref={ref}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingHorizontal: edgePad, paddingBottom: edgePad }]}
    >
      {messages.map((msg) => (
        <Bubble key={msg.id} role={msg.role} text={msg.text} pills={msg.pills} bubbleMaxPct={compact ? "94%" : "84%"} />
      ))}
      {showStreaming && (
        <Bubble
          role="assistant"
          text={streamingText.length > 0 ? streamingText : "…"}
          pills={streamingPills}
          streaming
          bubbleMaxPct={compact ? "94%" : "84%"}
        />
      )}
    </ScrollView>
  );
}

function Bubble({
  role,
  text,
  pills,
  streaming,
  bubbleMaxPct = "84%",
}: {
  role: Message["role"];
  text: string;
  pills?: Pill[];
  streaming?: boolean;
  bubbleMaxPct?: `${number}%`;
}) {
  const isUser = role === "user";
  return (
    <View style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          { maxWidth: bubbleMaxPct as `${number}%` },
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        <View style={[styles.edge, isUser ? styles.edgeUser : styles.edgeAssistant]} />
        <View style={styles.bubbleBody}>
          <Text style={styles.role}>{isUser ? "// you" : "// agent"}</Text>
          {isUser ? (
            <Text style={styles.bubbleTextUser}>{text}</Text>
          ) : (
            <AssistantMarkdown text={text || "…"} />
          )}
          {!isUser && pills && pills.length > 0 ? <PillRow pills={pills} /> : null}
          {streaming && <Text style={styles.streamingHint}>▍ streaming</Text>}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    paddingVertical: space.md,
    gap: space.md,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.xl,
    gap: 6,
  },
  emptyKicker: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.5,
  },
  emptyTitle: {
    color: palette.textPrimary,
    fontSize: 22,
    fontWeight: "600",
    fontFamily: fonts.body,
    letterSpacing: 0.3,
  },
  emptySub: {
    color: palette.textSecondary,
    textAlign: "center",
    maxWidth: 460,
    fontSize: 13,
    fontFamily: fonts.body,
    lineHeight: 20,
    marginTop: 4,
  },

  bubbleRow: { flexDirection: "row" },
  rowLeft: { justifyContent: "flex-start" },
  rowRight: { justifyContent: "flex-end" },
  bubble: {
    flexDirection: "row",
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  bubbleUser: {
    backgroundColor: "rgba(92, 246, 255, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(92, 246, 255, 0.18)",
    flexDirection: "row-reverse",
  },
  bubbleAssistant: {
    backgroundColor: "rgba(15, 22, 38, 0.72)",
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  edge: {
    width: 2,
    alignSelf: "stretch",
  },
  edgeUser: { backgroundColor: palette.cyan },
  edgeAssistant: { backgroundColor: palette.violetDim },
  bubbleBody: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 0,
  },
  role: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  bubbleTextUser: {
    color: palette.textPrimary,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.body,
  },
  streamingHint: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    marginTop: 6,
    letterSpacing: 1.2,
  },
});
