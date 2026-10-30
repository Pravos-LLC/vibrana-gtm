"use client";

import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { decideReportChange } from "@/app/performance/report/actions";
import { Button } from "@/components/ui/button";

const decidedLine = (status: string, by: string | null, at: string | null) =>
  `${status === "accepted" ? "Accepted" : "Dismissed"}${by ? ` by ${by.split("@")[0].replace(/^./, (c) => c.toUpperCase())}` : ""}${at ? `, ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`;

/** Accept or Dismiss one proposed change; once decided it collapses to a line saying who and when. */
export function ChangeDecision({ id, status, decidedBy, decidedAt }: { id: string; status: string; decidedBy: string | null; decidedAt: string | null }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState({ status, by: decidedBy, at: decidedAt, error: "" });
  if (state.status !== "proposed") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-2" role="status">
        {state.status === "accepted" ? <Check className="size-3.5 text-emerald-strong" aria-hidden /> : <X className="size-3.5 text-ink-3" aria-hidden />}
        {decidedLine(state.status, state.by, state.at)}
      </p>
    );
  }
  const act = (decision: "accept" | "dismiss") => start(async () => {
    const r = await decideReportChange(id, decision);
    setState(r.ok ? { status: r.status, by: r.decided_by, at: r.decided_at, error: "" } : { ...state, error: r.error });
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => act("accept")} title="Apply this change to the calendar. Nothing is approved or scheduled.">Accept</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("dismiss")}>Dismiss</Button>
      </div>
      {state.error && <p className="text-xs text-red-strong" role="alert">{state.error}</p>}
    </div>
  );
}
