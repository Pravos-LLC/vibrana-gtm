// Who may use the Signal Desk. The owner (gtm_owner) sees the whole cockpit; a team member (gtm_team,
// e.g. Abe while John is on leave) sees /signals only and can queue, save and dismiss stories, never
// approve or schedule anything. Both claims are server-set app_metadata, never user-editable metadata.
export type SignalsViewer = { role: "owner" | "team"; actor: string };

export function signalsViewer(claims: Record<string, unknown> | null | undefined): SignalsViewer | null {
  const meta = claims?.app_metadata as { gtm_owner?: boolean; gtm_team?: boolean } | undefined;
  const actor = typeof claims?.email === "string" ? claims.email : "cockpit";
  if (meta?.gtm_owner === true) return { role: "owner", actor };
  if (meta?.gtm_team === true) return { role: "team", actor };
  return null;
}

/** Paths a team member may open; everything else sends them back to /signals. */
export function teamMayOpen(path: string): boolean {
  return path === "/signals" || path.startsWith("/signals/") || path === "/auth/signout" || path === "/auth/reset";
}
