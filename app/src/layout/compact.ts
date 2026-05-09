import { useWindowDimensions } from "react-native";
import { space } from "../theme";

/** Viewports narrower than this use overlay navigation + stacked chrome. */
export const COMPACT_BREAKPOINT = 720;

export function useCompactLayout(): boolean {
  const { width } = useWindowDimensions();
  return width < COMPACT_BREAKPOINT;
}

/** Horizontal padding for scroll/list surfaces — tighter on phones. */
export function useScreenEdgePadding(): number {
  return useCompactLayout() ? space.md : space.xl;
}
