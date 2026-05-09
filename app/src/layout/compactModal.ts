import { space } from "../theme";

/**
 * Merged onto modal outer scrims (`modalBackdrop`, `overlay`) when
 * `useCompactLayout()` is true so dialogs span the viewport width with
 * comfortable edge padding instead of a floating centered sliver.
 */
export const compactModalBackdrop = {
  padding: space.sm,
  alignItems: "stretch" as const,
  justifyContent: "center" as const,
};

/**
 * Merged onto inner shells (`modalCard`, `panel`) — nearly full width
 * and height so scroll regions inside stay usable on phones.
 */
export const compactModalCard = {
  alignSelf: "stretch" as const,
  width: "100%" as const,
  maxWidth: "100%" as const,
  maxHeight: "96%" as const,
};
