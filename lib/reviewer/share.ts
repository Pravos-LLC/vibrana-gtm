// "Share for review": the message John sends a third party with their link, and the WhatsApp and Gmail compose URLs
// that carry it. Pure and browser-safe (the modal builds them as John edits the text).

export type ShareKind = "invite" | "access";
export type Share = { kind: ShareKind; party: string; url: string; email: string | null };

/** "example_approver / Example Series" -> "example_approver": who the greeting addresses (the part before a slash; else the whole name). */
export function firstName(party: string): string {
  const head = party.split("/")[0].trim();
  return party.includes("/") ? head.split(/\s+/)[0] : head;
}

/**
 * What is ready, as a clause with its verb, from the pieces whose final is staged (never one still in production):
 * '"Robots" is ready for your review', '3 pieces are ready for your review', or, with none final yet,
 * 'your review page is ready' (they will see the pieces as in production).
 */
export function whatIsReady(finals: string[], series?: string | null): { clause: string; subject: string } {
  if (finals.length === 1) return { clause: `"${finals[0]}" is ready for your review`, subject: finals[0] };
  if (finals.length > 1 && series) { const name = series.replaceAll("-", " "); return { clause: `the latest ${name} (${finals.length} pieces) are ready for your review`, subject: `${finals.length} ${name}` }; }
  if (finals.length > 1) return { clause: `${finals.length} pieces are ready for your review`, subject: `${finals.length} pieces` };
  return { clause: "your review page is ready", subject: "your review page" };
}

/** The default message. No em dashes (John's voice rules); John edits it in the modal before it goes. */
export function shareMessage(s: Share, what: { clause: string; subject: string }): { subject: string; text: string } {
  const how = s.kind === "invite"
    ? "Open the link, then review each video and approve it or tell us what to change. There is nothing to sign in to: come back to the same link any time, and you can share it with your cofounder."
    : `Sign in with the email and password you set up${s.email ? ` (${s.email})` : ""}, then approve it or tell us what to change.`;
  return { subject: `For your review: ${what.subject}`, text: `Hi ${firstName(s.party)}, ${what.clause}:\n${s.url}\n\n${how}` };
}

/** wa.me with the text; with a number it opens that chat, without one WhatsApp asks who to send it to. */
export function whatsappUrl(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Gmail compose, opened in the account John sends Vibrana mail from. */
export function gmailUrl(input: { to: string; subject: string; body: string; from?: string }): string {
  const q = new URLSearchParams({ view: "cm", fs: "1", to: input.to.trim(), su: input.subject, body: input.body });
  if (input.from) q.set("authuser", input.from);
  return `https://mail.google.com/mail/?${q.toString()}`;
}
