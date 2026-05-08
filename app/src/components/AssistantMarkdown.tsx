import { memo } from "react";
import { Linking, StyleSheet } from "react-native";
import Markdown, { type MarkdownProps } from "react-native-markdown-display";
import { fonts, palette } from "../theme";

/**
 * Renders assistant text as markdown, themed to the sci-fi palette.
 *
 * Tolerates partial markdown during streaming — markdown-it handles unclosed
 * fences and dangling inline tokens by rendering them as text, so each chunk
 * we re-render mid-stream stays readable.
 */
function AssistantMarkdownImpl({ text }: { text: string }) {
  return (
    <Markdown style={mdStyles} onLinkPress={onLinkPress}>
      {text}
    </Markdown>
  );
}

const onLinkPress: NonNullable<MarkdownProps["onLinkPress"]> = (url) => {
  void Linking.openURL(url).catch(() => {});
  return false;
};

const mdStyles = StyleSheet.create({
  body: { color: palette.textPrimary, fontSize: 15, lineHeight: 22, fontFamily: fonts.body },
  paragraph: { color: palette.textPrimary, marginTop: 0, marginBottom: 8, fontFamily: fonts.body },

  heading1: { color: palette.textPrimary, fontSize: 20, fontWeight: "700", marginTop: 8, marginBottom: 8, fontFamily: fonts.body, letterSpacing: 0.2 },
  heading2: { color: palette.textPrimary, fontSize: 17, fontWeight: "700", marginTop: 8, marginBottom: 6, fontFamily: fonts.body, letterSpacing: 0.2 },
  heading3: { color: palette.textPrimary, fontSize: 15, fontWeight: "600", marginTop: 6, marginBottom: 4, fontFamily: fonts.body },
  heading4: { color: palette.textPrimary, fontSize: 14, fontWeight: "600", marginTop: 4, marginBottom: 4, fontFamily: fonts.body },
  heading5: { color: palette.textSecondary, fontSize: 13, fontWeight: "600", fontFamily: fonts.mono, letterSpacing: 1, textTransform: "uppercase" },
  heading6: { color: palette.textSecondary, fontSize: 12, fontWeight: "600", fontFamily: fonts.mono, letterSpacing: 1, textTransform: "uppercase" },

  strong: { color: palette.textPrimary, fontWeight: "700" },
  em: { fontStyle: "italic" },
  s: { textDecorationLine: "line-through" },
  link: { color: palette.cyan, textDecorationLine: "underline" },
  blockquote: {
    backgroundColor: "rgba(15, 22, 38, 0.6)",
    borderLeftColor: palette.cyan,
    borderLeftWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 6,
  },

  hr: { backgroundColor: palette.borderHair, height: 1, marginVertical: 10 },

  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  list_item: { color: palette.textPrimary, marginBottom: 2, flexDirection: "row" },
  bullet_list_icon: { color: palette.cyan, marginRight: 8, lineHeight: 22 },
  ordered_list_icon: { color: palette.cyan, marginRight: 8, lineHeight: 22 },

  code_inline: {
    backgroundColor: "rgba(8, 11, 22, 0.85)",
    color: palette.amber,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    fontFamily: fonts.mono,
    fontSize: 13,
    borderWidth: 1,
    borderColor: palette.borderSoft,
  },
  code_block: {
    backgroundColor: "rgba(5, 7, 13, 0.92)",
    color: palette.textPrimary,
    padding: 12,
    borderRadius: 8,
    marginVertical: 6,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    borderWidth: 1,
    borderColor: palette.borderHair,
  },
  fence: {
    backgroundColor: "rgba(5, 7, 13, 0.92)",
    color: palette.textPrimary,
    padding: 12,
    borderRadius: 8,
    marginVertical: 6,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    borderWidth: 1,
    borderColor: palette.borderHair,
  },

  table: {
    borderWidth: 1,
    borderColor: palette.borderHair,
    borderRadius: 6,
    marginVertical: 8,
  },
  thead: { backgroundColor: "rgba(15, 22, 38, 0.5)" },
  th: {
    color: palette.textPrimary,
    fontWeight: "700",
    padding: 8,
    borderColor: palette.borderHair,
    borderRightWidth: 1,
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  td: {
    color: palette.textPrimary,
    padding: 8,
    borderColor: palette.borderHair,
    borderRightWidth: 1,
    borderTopWidth: 1,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});

export const AssistantMarkdown = memo(AssistantMarkdownImpl);
