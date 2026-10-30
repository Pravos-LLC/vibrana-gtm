import Link from "next/link";
import { Suspense } from "react";
import { Shell } from "@/components/shell";
import { sessionDb } from "@/lib/supabase/server";
import { readPages } from "@/lib/db-read";
import { GmailReader, header, MAILBOX, mailboxConfig, matchConversation, plainBody, validThreadId, type OutreachMail, type MailStatus } from "@/lib/outreach/mailbox";
import { InboxRefresh } from "@/components/outreach/inbox-refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "Outreach inbox" };
const labels: Record<MailStatus, string> = { reply: "Reply received", automated: "Automated response", "delivery-failure": "Delivery failure", "awaiting-reply": "Awaiting reply" };
const date = (value: string) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Makassar", dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ page?: string; thread?: string }> }) {
  const db = await sessionDb();
  // Explicitly gate before touching a server credential or Gmail, in addition to the page proxy and table RLS.
  const { data } = await db.auth.getClaims();
  if ((data?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) return <p role="alert">Sign in as the cockpit owner.</p>;
  const params = await searchParams;
  return <Shell title="Outreach inbox" active="/outreach/inbox" wide>
    <div className="mx-auto max-w-5xl space-y-5">
      <nav className="flex flex-wrap gap-4 text-sm"><Link href="/outreach/write" className="underline">Writing desk</Link><Link href="/outreach" className="underline">Draft review</Link></nav>
      <div><h2 className="font-semibold">{MAILBOX}</h2><p className="text-sm text-ink-2">Replies to your outreach, with conversation history. Open and click tracking are off.</p></div>
      <Suspense fallback={<p role="status">Checking the inbox…</p>}><InboxContent page={typeof params.page === "string" ? params.page : ""} threadId={typeof params.thread === "string" ? params.thread : ""} /></Suspense>
    </div>
  </Shell>;
}

async function InboxContent({ page, threadId }: { page: string; threadId: string }) {
  const config = mailboxConfig();
  if (!config) return <section className="rounded-lg border border-line p-5" data-testid="inbox-disconnected"><h3 className="font-medium">HQ inbox is not connected</h3><p className="mt-2 text-sm text-ink-2">Forward HQ mail to your everyday inbox, then connect that inbox to show replies here. Sent marks at the writing desk remain manual records.</p></section>;
  try {
    const [reader, drafts] = await Promise.all([
      GmailReader.connect(config),
      readPages<OutreachMail>((from, to) => (sessionDb().then((db) => db.from("gtm_outreach_drafts").select("id,subject,prospect,email_sent_at", { count: "exact" }).eq("status", "accepted").order("id").range(from, to))), "outreach recipients"),
    ]);
    const result = await reader.list(drafts, MAILBOX, page);
    let conversation = null;
    if (threadId) {
      if (!validThreadId(threadId)) throw new Error("Invalid conversation. Return to the inbox.");
      const thread = await reader.thread(threadId);
      const matched = matchConversation(thread, drafts, MAILBOX);
      if (!matched) throw new Error("This conversation does not match an accepted outreach email.");
      conversation = <section aria-label="Conversation" className="space-y-4 rounded-lg border border-line p-5"><h3 className="font-semibold">{matched.subject}</h3><Link href="/outreach/inbox" className="text-sm underline">Back to inbox</Link>
        {matched.forwarded && <p className="text-sm text-ink-2">Forwarded replies matched by sender, original HQ recipient, subject and your sent record. Sent history remains in HQ.</p>}
        {(thread.messages ?? []).filter((m) => !m.labelIds?.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)) && (!matched.forwarded || matched.messageIds?.includes(m.id))).map((message) => <article key={message.id} className="border-t border-line pt-4"><p className="text-sm font-medium">{header(message, "From")}</p><p className="text-xs text-ink-3">{date(Number.isFinite(Number(message.internalDate)) ? new Date(Number(message.internalDate)).toISOString() : "")}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{plainBody(message.payload) || message.snippet || "No plain-text preview available."}</p></article>)}
      </section>;
    }
    return <>
      <InboxRefresh />
      <p className="text-xs text-ink-3">Checked {date(new Date().toISOString())} (Bali). This page checks again every minute while visible. Reading here leaves Gmail unread status unchanged.</p>
      {conversation}
      <section aria-label="Outreach conversations" className="divide-y divide-line rounded-lg border border-line">
        {result.conversations.map((c) => <Link prefetch={false} key={c.id} href={`/outreach/inbox?${new URLSearchParams({ ...(page ? { page } : {}), thread: c.id })}`} className="block space-y-1 p-4 hover:bg-surface-card-hover"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{c.subject}</span><span className={c.status === "reply" ? "text-sm text-violet-strong" : "text-sm text-ink-2"}>{labels[c.status]}{c.unread ? " · Unread in Gmail" : ""}</span></div><p className="text-xs text-ink-3">{c.company} · {date(c.lastAt)} (Bali)</p><p className="line-clamp-2 text-sm text-ink-2">{c.snippet}</p></Link>)}
        {!result.conversations.length && <p className="p-5 text-sm text-ink-2">No matching outreach conversations on this page.</p>}
      </section>
      <p className="text-xs text-ink-3">Checked {result.scanned} HQ-related conversations from the last 90 days on this page. Forwarded replies require a matching sent record, sender, original HQ recipient and subject. Ambiguous matches are omitted. Forwarding does not include sent history or reliably identify separate bounce messages.</p>
      <nav className="flex gap-4 text-sm" aria-label="Inbox pages">{page && <Link href="/outreach/inbox" className="underline">Newest mail</Link>}{result.nextPageToken && <Link prefetch={false} href={`/outreach/inbox?${new URLSearchParams({ page: result.nextPageToken })}`} className="underline">Older mail</Link>}</nav>
    </>;
  } catch {
    return <p role="alert" className="rounded-lg border border-line p-5 text-sm text-red-strong">The HQ inbox could not be checked. Your messages are unchanged. Refresh to retry; if this continues, check the HQ Gmail connection.</p>;
  }
}
