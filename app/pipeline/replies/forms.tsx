"use client";
// Forms on /pipeline/replies: label a reply, approve a stop-list operation, try the classifier.
import { useActionState } from "react";
import { approveOperation, labelReply, tryClassifier } from "./actions";
import { Button } from "@/components/ui/button";

const select = "h-9 rounded-md border border-input bg-[color:var(--surface-inset)] px-2 text-sm text-ink";
const INTENTS: [string, string][] = [["interested", "Interested"], ["not_now", "Not now"], ["referral", "Referral"], ["not_interested", "Not interested"], ["neutral", "Neutral"], ["auto_reply", "Auto-reply"]];
const OPT_OUTS: [string, string][] = [["none", "Did not ask to stop"], ["person", "Stop emailing them"], ["address", "Stop this address only"]];

function Status({ state }: { state: { ok: boolean; message: string } | null }) {
  return state ? <span className={state.ok ? "text-xs text-ink-2" : "text-xs text-red-strong"} role="status">{state.message}</span> : null;
}

export function LabelForm({ eventId, intent, optOut }: { eventId: number; intent?: string; optOut?: string }) {
  const [state, action, pending] = useActionState(labelReply, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" aria-label="Label this reply">
      <input type="hidden" name="eventId" value={eventId} />
      <select name="intent" defaultValue={intent ?? ""} required className={select} aria-label="What they want">
        <option value="" disabled>What they want</option>
        {INTENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select name="optOut" defaultValue={optOut ?? "none"} className={select} aria-label="Asked to stop">
        {OPT_OUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      <Status state={state} />
    </form>
  );
}

export function ApproveForm({ opId }: { opId: number }) {
  const [state, action, pending] = useActionState(approveOperation, null);
  return (
    <form action={action} className="flex items-center gap-2" aria-label="Approve">
      <input type="hidden" name="opId" value={opId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "Approving…" : "Approve"}</Button>
      <Status state={state} />
    </form>
  );
}

export function TryClassifier() {
  const [state, action, pending] = useActionState(tryClassifier, null);
  return (
    <form action={action} className="grid gap-2 rounded-lg border border-line bg-[color:var(--surface-frost)] p-4" aria-label="Try the classifier">
      <textarea name="text" rows={3} maxLength={4000} required placeholder="Type a reply, e.g. “Thanks, not right now. Try me again in Q2.”"
        className="w-full rounded-md border border-input bg-[color:var(--surface-inset)] p-2 text-sm text-ink" aria-label="Reply text" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Asking Jev…" : "Classify"}</Button>
        <Status state={state} />
      </div>
      <p className="text-xs text-ink-3">Sent to Jev 1.13 through OpenCode and not stored. Use made-up text, not a real person&apos;s reply.</p>
    </form>
  );
}
