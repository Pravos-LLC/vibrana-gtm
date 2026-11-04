import Link from "next/link";
import { Section, Shell } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { sessionDb } from "@/lib/supabase/server";
import { gmailConfig } from "@/lib/team/mailbox";
import { viewer } from "@/lib/team/connect";
import { teamMembers } from "@/lib/team/members";
import { connectMailbox, disconnectMailbox } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mailbox connection" };

const STATUS: Record<string, string> = {
  connected: "Connected. The first sync runs within the hour and reads sent mail back to October 1, 2026.",
  disconnected: "Disconnected. Google access is revoked and every counted email was deleted.",
  declined: "Google consent was cancelled. Nothing was connected.",
  expired: "The connection request expired or came from another browser. Start again.",
  invalid: "Google sent back an incomplete answer. Start again.",
  "wrong-user": "The signed-in account changed during the connection. Start again from your own login.",
  "wrong-mailbox": "That Google account is not the mailbox configured for you, so it was not connected.",
  "google-refused": "Google did not grant offline, read-only metadata access. Start again and accept the permission.",
  "not-configured": "The Google connection is not set up in this deployment yet (TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET).",
  "not-member": "Your login is not a configured team member, so there is no mailbox to connect.",
  "save-failed": "The connection could not be saved. Try again.",
  "disconnect-failed": "Google access was revoked, but deleting the counted emails did not finish. Press Disconnect again.",
};

export default async function MailboxPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const v = await viewer();
  const db = await sessionDb();
  const { data } = await db.from("gtm_team_mailboxes").select("member,address,connected_at,last_sync_at,last_error,backfill_done");
  const rows = (data ?? []) as { member: string; address: string; connected_at: string; last_sync_at: string | null; last_error: string | null; backfill_done: boolean }[];
  const members = teamMembers();
  const mine = v?.member ? rows.filter((r) => r.member === v.member!.code) : [];
  return (
    <Shell title="Mailbox connection" active="/performance/team">
      {status && STATUS[status] && <Card glow={false} className="mb-8 p-4 text-sm text-ink-2" role="status">{STATUS[status]}</Card>}

      <Section title="What connecting does">
        <div className="max-w-3xl space-y-3 text-sm leading-relaxed text-ink-2">
          <p>Connecting lets the team performance page count the GTM emails you send from your work mailbox and the replies they get. You choose to connect, and you can disconnect at any time.</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong className="text-ink">Permission asked:</strong> Google&apos;s read-only <em>metadata</em> scope, plus your email address. It cannot send, delete or change anything, and Google does not give it message bodies.</li>
            <li><strong className="text-ink">Headers read:</strong> From, To, Cc, Date, and the auto-reply markers (Auto-Submitted, Precedence, X-Autoreply). Subjects are not read.</li>
            <li><strong className="text-ink">What is counted:</strong> an email to someone already in the CRM as a prospect (not a client, partner or personal contact), a reply in that thread, or a bounce. Mail to anyone else is skipped and never stored.</li>
            <li><strong className="text-ink">What is stored:</strong> Gmail message and thread ids, the day and time, the CRM record ids, and a keyed hash of each recipient so a reply can be matched. No address, subject or text.</li>
            <li><strong className="text-ink">Who sees it:</strong> the cockpit owners on Analytics, Team, the same page you see, including the list of counted emails.</li>
            <li><strong className="text-ink">Disconnecting</strong> revokes Google&apos;s access and deletes every counted email.</li>
          </ul>
        </div>
      </Section>

      <Section title="Your mailbox">
        {!v?.member ? (
          <p className="text-sm text-ink-2">Your login is not a configured team member, so there is no mailbox for you to connect. A team member connects their own mailbox from their own login.</p>
        ) : (
          <div className="space-y-4">
            {mine.length ? mine.map((r) => (
              <Card key={r.address} glow={false} className="p-4 text-sm">
                <p className="font-medium text-ink">{r.address}</p>
                <p className="text-ink-3">Connected {r.connected_at.slice(0, 10)}. {r.last_sync_at ? `Last sync ${r.last_sync_at.slice(0, 16).replace("T", " ")} UTC.` : "Not synced yet."} {r.backfill_done ? "" : "Still reading back to October 1."}</p>
                {r.last_error && <p className="mt-1 text-red-strong">{r.last_error}</p>}
              </Card>
            )) : <p className="text-sm text-ink-2">Not connected. Configured mailbox: {v.member.mailboxes.join(", ") || "none (ask John to add it)"}.</p>}
            <div className="flex gap-3">
              {gmailConfig() && v.member.mailboxes.length > 0 && (
                <form action={connectMailbox}><Button type="submit">{mine.length ? "Reconnect mailbox" : "Connect mailbox"}</Button></form>
              )}
              {mine.length > 0 && <form action={disconnectMailbox}><Button type="submit" variant="secondary">Disconnect and delete</Button></form>}
            </div>
            {!gmailConfig() && <p className="text-sm text-ink-3">{STATUS["not-configured"]}</p>}
          </div>
        )}
      </Section>

      <Section title="Team connections">
        <ul className="space-y-1 text-sm text-ink-2">
          {members.map((m) => {
            const r = rows.filter((x) => x.member === m.code);
            return <li key={m.code}><span className="text-ink">{m.label}</span>: {r.length ? r.map((x) => `${x.address}${x.last_error ? " (needs reconnecting)" : ""}`).join(", ") : "not connected"}</li>;
          })}
        </ul>
        <p className="mt-4 text-sm"><Link className="text-violet-strong underline-offset-4 hover:underline" href="/performance/team">Back to team performance</Link></p>
      </Section>
    </Shell>
  );
}
