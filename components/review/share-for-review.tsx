"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Copy, Mail, MessageCircle, RefreshCw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { gmailUrl, shareMessage, whatsappUrl, whatIsReady, type Share } from "@/lib/reviewer/share";

export type ShareForReviewAction = (input: { party: string; fresh?: boolean; reuse?: string }) => Promise<{ ok: true; share: Share } | { ok: false; error: string }>;

/** John sends Vibrana mail from this account; Gmail opens the compose window in it. */
const FROM = "user-f538cb95fc21@example.com";
type Contact = { phone: string; email: string };
const storeKey = (party: string) => `vibrana-share-to:${party}`;
/** The last unused link made in this browser, so reopening the modal shows it again (the server checks it is still open). */
const linkKey = (party: string) => `vibrana-share-link:${party}`;
const read = (key: string) => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } };

/**
 * One button wherever a piece names a third party: "Share for review". The modal makes (or reuses) their link,
 * writes the message, and sends it through WhatsApp or Gmail, or copies it. Their number and email are remembered
 * in this browser for next time.
 */
export function ShareForReview({ party, pieces, series, share, size = "sm", variant = "outline" }: {
  /** The pieces whose final is staged: what the message says is ready. */
  party: string; pieces: string[]; series?: string | null; share: ShareForReviewAction;
  size?: "sm" | "default"; variant?: "outline" | "default" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Share | null>(null);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [contact, setContact] = useState<Contact>({ phone: "", email: "" });
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const what = whatIsReady(pieces, series);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  // The dialog has nothing to focus until the link arrives: focus the message then (the Sheet focused the Close button).
  useEffect(() => { if (result) messageRef.current?.focus(); }, [result]);

  const prepare = (fresh = false) => {
    setError(null); setCopied(null); setResult(null);
    start(async () => {
      const r = await share({ party, fresh, reuse: read(linkKey(party)) });
      if (!r.ok) { setError(r.error); return; }
      // Keep the unused link to show again; once they have access it is spent, so forget it.
      try {
        if (r.share.kind === "invite") localStorage.setItem(linkKey(party), r.share.url.split("/invite/")[1] ?? "");
        else localStorage.removeItem(linkKey(party));
      } catch { /* private mode */ }
      const m = shareMessage(r.share, what);
      setResult(r.share); setText(m.text); setSubject(m.subject);
    });
  };

  useEffect(() => {
    if (!open) return;
    try { setContact({ phone: "", email: "", ...JSON.parse(localStorage.getItem(storeKey(party)) ?? "{}") }); } catch { /* nothing saved */ }
    prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, party]);

  const remember = (next: Contact) => {
    setContact(next);
    try { localStorage.setItem(storeKey(party), JSON.stringify(next)); } catch { /* private mode */ }
  };
  const copy = (what: "link" | "message") => {
    void navigator.clipboard.writeText(what === "link" ? result?.url ?? "" : text);
    setCopied(what);
  };

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}><Send /> Share for review</Button>
      <Sheet open={open} onOpenChange={setOpen} placement="center">
        <SheetHeader>
          <div className="flex items-start justify-between gap-3">
            <SheetTitle>Share for review with {party}</SheetTitle>
            <Button size="icon" variant="ghost" aria-label="Close" onClick={() => setOpen(false)}><X /></Button>
          </div>
          <p className="text-sm text-ink-2">
            {busy && !result ? "Preparing their link…"
              : result?.kind === "access" ? `They already have access${result.email ? ` as ${result.email}` : ""}. This sends them to their review page.`
              : result ? "A new private link. Up to two people can make a login with it, each with any email they choose (for example a cofounder), and it shows only their pieces' finals."
              : ""}
          </p>
        </SheetHeader>

        {result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-[color:var(--surface-frost)] px-2 py-1.5 text-xs text-ink">{result.url}</code>
              <Button size="sm" variant="outline" onClick={() => copy("link")}>{copied === "link" ? <><Check /> Copied</> : <><Copy /> Copy link</>}</Button>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-2">Message</span>
              <textarea ref={messageRef} value={text} rows={8} onChange={(e) => setText(e.target.value)}
                className="w-full rounded-md border border-[color:var(--border-default)] bg-transparent p-2.5 text-sm text-ink outline-none focus:border-[color:var(--border-strong)]" />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-2">WhatsApp number (optional)</span>
                  <Input value={contact.phone} inputMode="tel" placeholder="+57 300 000 0000" onChange={(e) => remember({ ...contact, phone: e.target.value })} />
                </label>
                <Button className="w-full" asChild>
                  <a href={whatsappUrl(contact.phone, text)} target="_blank" rel="noreferrer"><MessageCircle /> Send on WhatsApp</a>
                </Button>
              </div>
              <div className="space-y-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-2">Email (optional)</span>
                  <Input value={contact.email} type="email" placeholder="name@example.com" onChange={(e) => remember({ ...contact, email: e.target.value })} />
                </label>
                <Button className="w-full" variant="outline" asChild>
                  <a href={gmailUrl({ to: contact.email, subject, body: text, from: FROM })} target="_blank" rel="noreferrer"><Mail /> Send with Gmail</a>
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <Button size="sm" variant="ghost" onClick={() => copy("message")}>{copied === "message" ? <><Check /> Message copied</> : <><Copy /> Copy message</>}</Button>
              {result.kind === "access" && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => prepare(true)}><RefreshCw /> New link instead</Button>
              )}
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-strong">{error}</p>}
      </Sheet>
    </>
  );
}
