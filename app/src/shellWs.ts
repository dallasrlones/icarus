import { apiBaseUrl } from "./baseUrl";
import { getToken } from "./auth";

/** WebSocket URL for `GET /v1/shell` upgrade (JWT query param, same as `/v1/events`). */
export function buildShellWsUrl(scope: "global" | "project", slug?: string): string | null {
  const token = getToken();
  if (!token) return null;
  const base = apiBaseUrl().replace(/^http/, "ws");
  const q = new URLSearchParams({ token, scope });
  if (scope === "project" && slug) q.set("slug", slug);
  return `${base}/v1/shell?${q.toString()}`;
}
