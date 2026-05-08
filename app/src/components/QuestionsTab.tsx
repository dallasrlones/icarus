import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { fonts, glow, palette, radii, space } from "../theme";
import type { Question, Task } from "../types";

/**
 * Per-project questions surface. The autonomous queue uses
 * `enqueue_question` whenever it can't proceed without the user; those
 * questions land here.
 *
 * Each card has an inline reply box (or option chips, when the question
 * specified them) that fires `answer_question` and the optional dismiss
 * action that fires `dismiss_question`.
 *
 * Closed questions (answered / dismissed) are listed below in a faded
 * section so the user can audit what was decided.
 */

interface Props {
  questions: Question[];
  tasks: Task[];
  onAnswer: (questionId: string, answer: string, choice?: number) => void;
  onDismiss: (questionId: string) => void;
  /**
   * Phase 15.2 — voice loop. When voice is unavailable (mic / TTS
   * env unset, or native), this is undefined and the SPEAK button
   * doesn't render. When set, clicking it reads the question
   * aloud and locks the global voice target so the next
   * confirmed transcript fires `answer_question`.
   */
  onSpeakQuestion?: (question: Question) => void;
  /**
   * Highlight the question currently locked as the voice target
   * (so the user sees which card their next utterance will
   * answer). Optional — when undefined, no highlight.
   */
  activeVoiceQuestionId?: string | null;
}

export function QuestionsTab({
  questions,
  tasks,
  onAnswer,
  onDismiss,
  onSpeakQuestion,
  activeVoiceQuestionId,
}: Props) {
  const open = questions.filter((q) => q.status === "open");
  const closed = questions.filter((q) => q.status !== "open");

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner}>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>// open ({open.length})</Text>
        {open.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No open questions</Text>
            <Text style={styles.emptySub}>
              When the queue worker hits a fork in the road it'll surface
              the choice here.
            </Text>
          </View>
        ) : (
          open.map((q) => (
            <OpenQuestionCard
              key={q.id}
              question={q}
              taskTitle={taskById.get(q.task_id)?.title}
              onAnswer={onAnswer}
              onDismiss={onDismiss}
              onSpeak={onSpeakQuestion ? () => onSpeakQuestion(q) : undefined}
              isVoiceTarget={activeVoiceQuestionId === q.id}
            />
          ))
        )}
      </View>

      {closed.length > 0 && (
        <View style={[styles.section, { opacity: 0.7 }]}>
          <Text style={styles.sectionLabel}>// resolved ({closed.length})</Text>
          {closed.map((q) => (
            <ClosedQuestionCard
              key={q.id}
              question={q}
              taskTitle={taskById.get(q.task_id)?.title}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function OpenQuestionCard({
  question,
  taskTitle,
  onAnswer,
  onDismiss,
  onSpeak,
  isVoiceTarget,
}: {
  question: Question;
  taskTitle?: string;
  onAnswer: (id: string, answer: string, choice?: number) => void;
  onDismiss: (id: string) => void;
  onSpeak?: () => void;
  isVoiceTarget?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const hasOptions = question.options && question.options.length > 0;

  return (
    <View
      style={[
        styles.openCard,
        // Phase 15.2 — when this question is the locked voice
        // target, soften the existing amber edge to a cyan glow
        // so the user sees "this is where my next voice utterance
        // is going". Auto-clears whenever the target resets
        // (confirm/discard/cancel/another-speak).
        isVoiceTarget && {
          borderLeftColor: palette.cyan,
          ...glow(palette.cyanGlow, 18),
        },
      ]}
    >
      <View style={styles.openHeader}>
        <Text style={styles.openTag}>QUESTION</Text>
        <Text style={styles.openTask} numberOfLines={1}>
          {taskTitle ? `task · ${taskTitle}` : `task ${question.task_id}`}
        </Text>
        {onSpeak ? (
          // Voice loop entry point: tap = read aloud + lock the
          // voice target. The user then taps the global mic button
          // to record an answer; the preview bubble shows where
          // it's headed and the SEND fires `answer_question`
          // instead of a chat message.
          <Pressable
            onPress={onSpeak}
            style={({ pressed }) => [
              styles.speakBtn,
              isVoiceTarget && styles.speakBtnActive,
              pressed && glow(palette.cyan, 12),
            ]}
            accessibilityLabel={
              isVoiceTarget
                ? "Question is the active voice target"
                : "Read this question aloud and answer by voice"
            }
          >
            <Text
              style={[
                styles.speakBtnText,
                isVoiceTarget && { color: palette.cyan },
              ]}
            >
              {isVoiceTarget ? "● VOICE READY" : "🔊 SPEAK & ANSWER"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.openBody}>{question.body}</Text>

      {hasOptions ? (
        <View style={styles.options}>
          {question.options!.map((opt, i) => (
            <Pressable
              key={`${i}-${opt}`}
              onPress={() => onAnswer(question.id, opt, i)}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && glow(palette.cyan, 12),
              ]}
            >
              <Text style={styles.optionText}>{opt}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.replyRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Your answer…"
            placeholderTextColor={palette.textMuted}
            style={styles.replyInput}
            multiline
          />
          <Pressable
            disabled={draft.trim().length === 0}
            onPress={() => {
              const v = draft.trim();
              if (!v) return;
              onAnswer(question.id, v);
              setDraft("");
            }}
            style={({ pressed }) => [
              styles.replyBtn,
              draft.trim().length === 0 && { opacity: 0.4 },
              pressed && glow(palette.cyan, 12),
            ]}
          >
            <Text style={styles.replyBtnText}>SEND</Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={() => onDismiss(question.id)} style={styles.dismissBtn}>
        <Text style={styles.dismissText}>dismiss</Text>
      </Pressable>
    </View>
  );
}

function ClosedQuestionCard({
  question,
  taskTitle,
}: {
  question: Question;
  taskTitle?: string;
}) {
  return (
    <View style={styles.closedCard}>
      <View style={styles.openHeader}>
        <Text style={[styles.openTag, { color: palette.textSecondary }]}>
          {question.status === "answered" ? "ANSWERED" : "DISMISSED"}
        </Text>
        <Text style={styles.openTask} numberOfLines={1}>
          {taskTitle ? `task · ${taskTitle}` : `task ${question.task_id}`}
        </Text>
      </View>
      <Text style={styles.closedBody} numberOfLines={3}>
        {question.body}
      </Text>
      {question.answer && (
        <Text style={styles.closedReply} numberOfLines={3}>
          → {question.answer}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollInner: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 },
  section: { gap: space.md },
  sectionLabel: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },

  openCard: {
    backgroundColor: palette.bgPanel,
    borderRadius: radii.md,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: palette.borderHair,
    borderLeftColor: palette.amber,
    padding: space.lg,
    gap: space.md,
  },
  openHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    flexWrap: "wrap",
  },
  openTag: {
    color: palette.amber,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: "700",
  },
  openTask: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    flex: 1,
  },
  speakBtn: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: palette.bgBase,
  },
  speakBtnActive: {
    borderColor: palette.cyan,
    backgroundColor: "rgba(92, 246, 255, 0.08)",
  },
  speakBtnText: {
    color: palette.cyanDim,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: "700",
  },
  openBody: {
    color: palette.textPrimary,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  optionBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: palette.bgBase,
  },
  optionText: {
    color: palette.cyan,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  replyRow: {
    flexDirection: "row",
    gap: space.sm,
    alignItems: "flex-end",
  },
  replyInput: {
    flex: 1,
    minHeight: 38,
    maxHeight: 96,
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
  replyBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.cyanDim,
    backgroundColor: palette.bgBase,
  },
  replyBtnText: {
    color: palette.cyan,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
  },
  dismissBtn: { alignSelf: "flex-end" },
  dismissText: {
    color: palette.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },

  empty: {
    padding: space.xl,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: palette.borderHair,
    borderRadius: radii.md,
    gap: 6,
    alignItems: "center",
  },
  emptyTitle: {
    color: palette.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  emptySub: {
    color: palette.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
    textAlign: "center",
    maxWidth: 360,
  },

  closedCard: {
    backgroundColor: palette.bgRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.borderHair,
    padding: space.lg,
    gap: space.sm,
  },
  closedBody: {
    color: palette.textSecondary,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  closedReply: {
    color: palette.cyan,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
