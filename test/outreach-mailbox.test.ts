import test from "node:test";
import assert from "node:assert/strict";
import { GmailReader, MAILBOX, mailboxConfig, matchConversation, plainBody, validThreadId, validPageToken, type MailMessage } from "../lib/outreach/mailbox";

const draft = { id: "draft", subject: "The research note", prospect: { email: "buyer@example.test", company: "Example" } };
function message(from: string, at: number, extra: Partial<MailMessage> = {}): MailMessage {
  return { id: String(at), internalDate: String(at), payload: { headers: [{ name: "From", value: from }, { name: "To", value: draft.prospect.email }, { name: "Subject", value: draft.subject }] }, ...extra };
}
const sent = () => message(MAILBOX, 1000, { labelIds: ["SENT"] });
const read = (...messages: MailMessage[]) => matchConversation({ id: "abc123", messages }, [draft], MAILBOX);

test("a real reply needs an actual sent message matching the exact recipient and subject", () => {
  const reply = message("Buyer <buyer@example.test>", 2000, { labelIds: ["INBOX", "UNREAD"], snippet: "Let's talk" });
  assert.equal(read(sent(), reply)?.status, "reply");
  assert.equal(read(sent(), reply)?.unread, true);
  assert.equal(read(reply), null);
  const wrong = sent(); wrong.payload!.headers![1].value = "someone-else@example.test";
  assert.equal(read(wrong, reply), null);
  const wrongSubject = sent(); wrongSubject.payload!.headers![2].value = "Other subject";
  assert.equal(read(wrongSubject, reply), null);
  assert.equal(read({ ...sent(), labelIds: ["DRAFT"] }, reply), null);
  assert.equal(read(sent(), message("stranger@example.test", 2000))?.status, "awaiting-reply");
  assert.equal(read(sent(), message(draft.prospect.email, 900))?.status, "awaiting-reply");
});

test("bounce, automated response, own follow-up and human reply are distinct", () => {
  const automatic = message(draft.prospect.email, 2000);
  automatic.payload!.headers!.push({ name: "Auto-Submitted", value: "auto-replied" });
  assert.equal(read(sent(), automatic)?.status, "automated");
  assert.equal(read(sent(), message("mailer-daemon@example.test", 2000))?.status, "delivery-failure");
  assert.equal(read(sent(), message(MAILBOX, 2000, { labelIds: ["SENT"] }))?.status, "awaiting-reply");
  assert.equal(read(sent(), automatic, message(draft.prospect.email, 3000))?.status, "reply");
});

test("plain text is decoded; HTML, remote images, attachments and unsafe ids are excluded", () => {
  assert.equal(plainBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: Buffer.from('<img src="https://tracker.test/pixel">').toString("base64url") } }, { mimeType: "text/plain", body: { data: Buffer.from("A useful reply").toString("base64url") } }] }), "A useful reply");
  assert.equal(validThreadId("../../profile"), false);
  assert.equal(validThreadId("abc123"), true);
  assert.equal(validPageToken("bad&query"), false);
  assert.equal(validPageToken("x".repeat(2049)), false);
  assert.equal(mailboxConfig({} as NodeJS.ProcessEnv), null);
});

const config = { email: MAILBOX, clientId: "client-test", clientSecret: "secret-test", refreshToken: "refresh-test" };
test("connection verifies the mailbox before reading messages and keeps provider errors and tokens private", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    paths.push(String(input));
    if (String(input).endsWith("/token")) { assert.equal(init?.method, "POST"); return Response.json({ access_token: "access-test" }); }
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ emailAddress: "wrong@example.test" });
  };
  await assert.rejects(GmailReader.connect(config, fetcher), /not the configured inbox/);
  assert.equal(paths.length, 2);
  await assert.rejects(GmailReader.connect(config, async () => new Response("sensitive provider response", { status: 400 })), /^Error: The HQ inbox connection needs to be renewed\.$/);
});

test("Gmail is paginated, metadata-only for lists, with bounded concurrent reads and no label writes", async () => {
  let active = 0, peak = 0;
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname.endsWith("/threads")) {
      assert.equal(url.searchParams.get("pageToken"), "next-token");
      assert.equal(url.searchParams.get("q"), `{from:${MAILBOX} to:${MAILBOX} cc:${MAILBOX}} newer_than:90d -in:trash -in:spam`);
      return Response.json({ threads: Array.from({ length: 9 }, (_, i) => ({ id: `abc${i}` })), nextPageToken: "older" });
    }
    assert.equal(url.searchParams.get("format"), "metadata");
    assert.ok(url.searchParams.getAll("metadataHeaders").includes("Cc"));
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1)); active--;
    return Response.json({ id: url.pathname.split("/").at(-1), messages: [sent()] });
  };
  const page = await new GmailReader("access-test", fetcher).list([draft], MAILBOX, "next-token");
  assert.equal(page.conversations.length, 9);
  assert.equal(page.nextPageToken, "older");
  assert.equal(peak, 4);
  assert.equal(paths.length, 10);
  await assert.rejects(new GmailReader("access-test", fetcher).thread("../profile"), /Invalid conversation/);
});


test("email-looking display names and comments never bind another sender or recipient", () => {
  const spoof = message('"buyer@example.test" <stranger@example.test>', 2000);
  assert.equal(read(sent(), spoof)?.status, "awaiting-reply");
  const wrongRecipient = sent();
  wrongRecipient.payload!.headers![1].value = '"buyer@example.test" <someone-else@example.test>';
  assert.equal(read(wrongRecipient, message(draft.prospect.email, 2000)), null);
  const comment = message('stranger@example.test (buyer@example.test)', 2000);
  assert.equal(read(sent(), comment)?.status, "awaiting-reply");
  assert.equal(read(sent(), message('"Buyer, Example" <buyer@example.test>', 2000))?.status, "reply");
});

const forwardedDraft = { ...draft, email_sent_at: new Date(1000).toISOString() };
function forwarded(extra: Partial<MailMessage> = {}): MailMessage {
  return { ...message(draft.prospect.email, 2000), labelIds: ["INBOX", "UNREAD"], payload: { headers: [
    { name: "From", value: `Buyer <${draft.prospect.email}>` }, { name: "To", value: MAILBOX },
    { name: "Subject", value: `Re: ${draft.subject}` },
  ] }, ...extra };
}
const readForwarded = (...messages: MailMessage[]) => matchConversation({ id: "abc123", messages }, [forwardedDraft], MAILBOX);

test("forwarded replies bind a uniquely matching sent record without requiring a sent copy in the central inbox", () => {
  const unrelated = message("private@example.test", 3000);
  const result = readForwarded(forwarded(), unrelated)!;
  assert.equal(result.status, "reply");
  assert.equal(result.forwarded, true);
  assert.equal(result.unread, true);
  assert.deepEqual(result.messageIds, ["2000"]);
  assert.equal(result.lastAt, new Date(2000).toISOString());
  assert.equal(matchConversation({ id: "abc123", messages: [forwarded()] }, [forwardedDraft, { ...forwardedDraft, id: "duplicate" }], MAILBOX), null);
  assert.equal(matchConversation({ id: "abc123", messages: [forwarded()] }, [draft], MAILBOX), null);
});

test("forwarded matching rejects wrong headers, unsent or older mail, drafts, spam and manual forwards", () => {
  for (const [name, value] of [["From", '"buyer@example.test" <stranger@example.test>'], ["To", "user-f538cb95fc21@example.com"], ["Subject", "Another subject"], ["From", MAILBOX]]) {
    const m = forwarded(); m.payload!.headers!.find((h) => h.name === name)!.value = value;
    assert.equal(readForwarded(m), null, name);
  }
  for (const label of ["DRAFT", "SPAM", "TRASH", "SENT"]) assert.equal(readForwarded(forwarded({ labelIds: [label] })), null, label);
  for (const at of ["900", "NaN", "Infinity", "8640000000000001"]) assert.equal(readForwarded(forwarded({ internalDate: at })), null, at);
  const cc = forwarded(); cc.payload!.headers!.find((h) => h.name === "To")!.name = "Cc";
  assert.equal(readForwarded(cc)?.status, "reply");
  const auto = forwarded(); auto.payload!.headers!.push({ name: "Auto-Submitted", value: "auto-replied" });
  assert.equal(readForwarded(auto)?.status, "automated");
});

test("a central inbox connection verifies its primary account while matching remains scoped to the HQ address", async () => {
  const central = mailboxConfig({ OUTREACH_GMAIL_CLIENT_ID: "client-test", OUTREACH_GMAIL_CLIENT_SECRET: "secret-test", OUTREACH_GMAIL_REFRESH_TOKEN: "refresh-test", OUTREACH_GMAIL_ACCOUNT: "user-8dd8662c2f5a@example.com" })!;
  assert.equal(central.email, "user-8dd8662c2f5a@example.com");
  assert.equal(mailboxConfig({ OUTREACH_GMAIL_CLIENT_ID: "x", OUTREACH_GMAIL_CLIENT_SECRET: "x", OUTREACH_GMAIL_REFRESH_TOKEN: "x", OUTREACH_GMAIL_ACCOUNT: "address&query" }), null);
  const paths: string[] = [];
  const reader = await GmailReader.connect(central, async (input) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname === "/token") return Response.json({ access_token: "access-test" });
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: central.email });
    if (url.pathname.endsWith("/threads")) {
      assert.match(url.searchParams.get("q")!, /example.com/);
      assert.doesNotMatch(url.searchParams.get("q")!, /sample-author/);
      return Response.json({ threads: [{ id: "abc123" }] });
    }
    return Response.json({ id: "abc123", messages: [forwarded()] });
  });
  assert.equal((await reader.list([forwardedDraft], MAILBOX)).conversations[0]?.forwarded, true);
  assert.equal(paths.length, 4);
});
