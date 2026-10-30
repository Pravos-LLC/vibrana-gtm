// Third-party review links: what a reviewer may open, and what /shared shows them (lib/reviewer/*).
import test from "node:test";
import assert from "node:assert/strict";
import { authorName, inviteUrl, isReviewer, publicPath, reviewerMayOpen, thirdPartyAuthor, validToken } from "../lib/reviewer/access.ts";
import { inviteState, newInviteToken, tokenSha256 } from "../lib/reviewer/invites.ts";
import { buildSharedPieces, type SharedInput } from "../lib/reviewer/shared.ts";
import { eventSubject } from "../lib/reviewer/notify.ts";
import { thirdPartyApproved, type HoldAsset, type ThirdPartyDecision } from "../lib/third-party.ts";
import type { StoryAsset } from "../lib/story.ts";

const example_approver = "example_approver / Example Series";

test("a reviewer opens /shared, their link and sign out, nothing else", () => {
  for (const p of ["/shared", "/shared/x", "/invite/abc", "/auth/signout", "/auth/reset"]) assert.equal(reviewerMayOpen(p), true, p);
  for (const p of ["/", "/content", "/studio", "/signals", "/stories/s1-18", "/sharedx", "/login", "/api/cron/sync"]) assert.equal(reviewerMayOpen(p), false, p);
  assert.equal(publicPath("/invite/abc"), true);
  assert.equal(publicPath("/login"), true);
  assert.equal(publicPath("/auth/reset"), true, "the emailed reset link opens signed out");
  assert.equal(publicPath("/auth/signout"), false);
  assert.equal(publicPath("/shared"), false, "signed out, /shared asks for a login");
});

test("the reviewer flag never outranks the owner or team claims", () => {
  assert.equal(isReviewer({ gtm_reviewer: true }), true);
  assert.equal(isReviewer({ gtm_reviewer: true, gtm_owner: true }), false);
  assert.equal(isReviewer({ gtm_reviewer: true, gtm_team: true }), false);
  assert.equal(isReviewer({}), false);
  assert.equal(isReviewer(undefined), false);
});

test("tokens are 256-bit, URL-safe, and only their hash is kept", () => {
  const a = newInviteToken(), b = newInviteToken();
  assert.notEqual(a.token, b.token);
  assert.equal(validToken(a.token), true);
  assert.equal(a.sha256, tokenSha256(a.token));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(validToken("short"), false);
  assert.equal(validToken(`${a.token.slice(0, 42)}/`), false);
  assert.equal(inviteUrl("https://gtm.example.com/", a.token), `https://gtm.example.com/invite/${a.token}`);
});

test("invite state: revoked wins, then claimed, then expiry", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const base = { expires_at: "2026-10-20T00:00:00Z", claimed_at: null, revoked_at: null };
  assert.equal(inviteState(base, now), "open");
  assert.equal(inviteState({ ...base, expires_at: "2026-10-12T00:00:00Z" }, now), "expired");
  assert.equal(inviteState({ ...base, expires_at: "2026-10-12T00:00:00Z", claimed_at: "2026-10-11T00:00:00Z" }, now), "claimed", "a claimed link outlives its claim window");
  assert.equal(inviteState({ ...base, claimed_at: "2026-10-11T00:00:00Z", revoked_at: "2026-10-12T00:00:00Z" }, now), "revoked");
});

test("a link makes up to two logins: one used still reads open, both used reads claimed", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const base = { expires_at: "2026-10-20T00:00:00Z", claimed_at: "2026-10-12T00:00:00Z", revoked_at: null, max_accounts: 2 };
  assert.equal(inviteState({ ...base, accounts: 0, claimed_at: null }, now), "open");
  assert.equal(inviteState({ ...base, accounts: 1 }, now), "open", "example_approver's cofounder can still use it");
  assert.equal(inviteState({ ...base, accounts: 2 }, now), "claimed");
  assert.equal(inviteState({ ...base, accounts: 1, expires_at: "2026-10-12T00:00:00Z" }, now), "expired", "an expired link makes no new login; the logins already made keep working");
  assert.equal(inviteState({ ...base, accounts: 1, revoked_at: "2026-10-12T00:00:00Z" }, now), "revoked");
});

test("note authors: the third party is named, John is not", () => {
  assert.equal(thirdPartyAuthor(example_approver), "third_party:example_approver / Example Series");
  assert.equal(authorName("third_party:example_approver / Example Series"), example_approver);
  assert.equal(authorName("john"), null);
  assert.equal(authorName(undefined), null);
});

const asset = (o: Partial<StoryAsset> & { id: string; story_id: string; kind: StoryAsset["kind"] }): StoryAsset => ({
  title: o.id, source: `${o.id}.mp4`, sha256: "a".repeat(64), revision: 1, storage_path: `stories/${o.id}`, body: null, url: null, metadata: {}, stage: "final", ...o,
});
const decision = (o: Partial<SharedInput["decisions"][number]>): SharedInput["decisions"][number] => ({
  id: "d1", story_id: "s1-18-sn-a", asset_id: "a-video", asset_sha256: "a".repeat(64), revision: 1, decision: "approved", note: "", decided_at: "2026-10-13T10:00:00Z", ...o,
});
function input(over: Partial<SharedInput> = {}): SharedInput {
  return {
    parties: [example_approver],
    stories: [
      { id: "s1-18-sn-a", title: "S1-18 | Robots and the Mamos", third_party_who: example_approver, pipeline: "episode" },
      { id: "s1-19-sn-b", title: "S1-19 | Rough one", third_party_who: example_approver },
      { id: "s1-05-meridian", title: "S1-05 | Meridian proof", third_party_who: null },
      { id: "s1-30-other", title: "S1-30 | Someone else", third_party_who: "Other Partner" },
    ],
    assets: [
      asset({ id: "a-video", story_id: "s1-18-sn-a", kind: "video", metadata: { label: "v4", poster_path: "stories/a-poster" } }),
      asset({ id: "a-copy", story_id: "s1-18-sn-a", kind: "copy", body: "---\nfirst_comment: x\n---\n\nThe Mamos on robots.\n" }),
      asset({ id: "a-copy-li", story_id: "s1-18-sn-a", kind: "copy", body: "Draft [JOHN: pick a hook]" }),
      asset({ id: "a-plan", story_id: "s1-18-sn-a", kind: "image", stage: "enhance-plan" }),
      asset({ id: "b-video", story_id: "s1-19-sn-b", kind: "video", stage: "rough-cut" }),
      asset({ id: "m-video", story_id: "s1-05-meridian", kind: "video" }),
      asset({ id: "o-video", story_id: "s1-30-other", kind: "video" }),
    ],
    channels: [
      { asset_id: "a-video", channel: "youtube", status: "approved", approved_sha256: null, note: "" },
      { asset_id: "a-video", channel: "instagram", status: "approved", approved_sha256: null, note: "" },
      { asset_id: "a-copy", channel: "instagram", status: "pending", approved_sha256: null, note: "" },
      { asset_id: "a-copy-li", channel: "linkedin", status: "pending", approved_sha256: null, note: "" },
      { asset_id: "b-video", channel: "youtube", status: "pending", approved_sha256: null, note: "" },
      { asset_id: "m-video", channel: "youtube", status: "pending", approved_sha256: null, note: "" },
      { asset_id: "o-video", channel: "youtube", status: "pending", approved_sha256: null, note: "" },
    ],
    decisions: [],
    versions: [{ asset_id: "a-video", revision: 1, metadata: { label: "v4" } }],
    url: (p) => (p ? `https://signed.test/${p}` : null),
    ...over,
  };
}

test("/shared shows only the party's pieces, never another's or an unassigned one", () => {
  const pieces = buildSharedPieces(input());
  assert.deepEqual(pieces.map((p) => p.storyId), ["s1-18-sn-a", "s1-19-sn-b"]);
  assert.deepEqual(buildSharedPieces(input({ parties: [] })), [], "no parties, nothing");
});

test("the full episode comes first, then the shorts in id order", () => {
  const base = input();
  const stories = base.stories.map((s) => (s.id === "s1-19-sn-b" ? { ...s, pipeline: "episode" } : s.id === "s1-18-sn-a" ? { ...s, pipeline: null } : s));
  assert.deepEqual(buildSharedPieces({ ...base, stories }).map((p) => p.storyId), ["s1-19-sn-b", "s1-18-sn-a"]);
});

test("a rough cut is never shown: the piece reads in production with no assets", () => {
  const rough = buildSharedPieces(input()).find((p) => p.storyId === "s1-19-sn-b")!;
  assert.equal(rough.state, "in-production");
  assert.deepEqual(rough.assets, []);
});

test("the final: the video first, then each platform's listing; no plan image; a listing with a note to John is withheld", () => {
  const p = buildSharedPieces(input())[0];
  assert.equal(p.state, "final");
  assert.equal(p.name, "Robots and the Mamos");
  assert.deepEqual(p.assets.map((a) => [a.id, a.kind]), [["a-video", "video"], ["a-copy", "copy"]]);
  const v = p.assets[0];
  assert.deepEqual([v.label, v.src, v.poster, v.channels], ["v4", "https://signed.test/stories/a-video", "https://signed.test/stories/a-poster", ["youtube", "instagram"]]);
  assert.deepEqual(p.assets[1].listing, { title: null, text: "The Mamos on robots.", thumbnail: null }, "frontmatter is dropped");
});

test("a YouTube listing carries its title and signed thumbnail", () => {
  const copy = asset({ id: "y-copy", story_id: "s1-18-sn-a", kind: "copy", body: '---\nyoutube_title: "From Web 3 to Indigenous Prophecy"\n---\n\nA man arrives.\n', metadata: { thumbnail_path: "stories/y-thumb.jpg" } });
  const base = input();
  const p = buildSharedPieces({ ...base, assets: [...base.assets, copy], channels: [...base.channels, { asset_id: "y-copy", channel: "youtube", status: "pending", approved_sha256: null, note: "" }] })[0];
  assert.deepEqual(p.assets.find((a) => a.id === "y-copy")!.listing, { title: "From Web 3 to Indigenous Prophecy", text: "A man arrives.", thumbnail: "https://signed.test/stories/y-thumb.jpg" });
});

test("each asset is decided on its own: the latest decision on its current bytes; an older version reads as new", () => {
  const first = buildSharedPieces(input())[0];
  assert.deepEqual(first.assets.map((a) => a.decision), ["pending", "pending"]);
  assert.equal(first.decision, "pending");
  const rows = [decision({ id: "d1", decision: "changes", note: "Fix the title", decided_at: "2026-10-13T09:00:00Z" }), decision({ id: "d2", decision: "approved", decided_at: "2026-10-13T10:00:00Z" })];
  const p = buildSharedPieces(input({ decisions: rows }))[0];
  assert.equal(p.assets[0].decision, "approved");
  assert.equal(p.assets[1].decision, "pending", "approving the video approves nothing else");
  assert.equal(p.decision, "approved", "the piece is approved once every video is; the listing is not decided on");
  const flipped = buildSharedPieces(input({ decisions: [rows[1], { ...rows[0], decided_at: "2026-10-13T11:00:00Z" }] }))[0];
  assert.equal(flipped.assets[0].decision, "changes");
  assert.equal(flipped.decision, "changes");
  const old = buildSharedPieces(input({ decisions: [decision({ asset_sha256: "b".repeat(64) })] }))[0].assets[0];
  assert.equal(old.decision, "pending");
  assert.equal(old.newVersion, true);
  const all = buildSharedPieces(input({ decisions: [decision({ id: "d1" }), decision({ id: "d2", asset_id: "a-copy" })] }))[0];
  assert.equal(all.decision, "approved");
});

test("a short reaches them only once John has approved its YouTube cut, and shows one video with no listing", () => {
  const unapproved = input();
  assert.equal(buildSharedPieces({ ...unapproved, stories: unapproved.stories.map((s) => (s.id === "s1-18-sn-a" ? { ...s, pipeline: null } : s)) })[0].state, "in-production", "not approved by John: not shown");
  const base = input({ channels: input().channels.map((c) => (c.asset_id === "a-video" && c.channel === "youtube" ? { ...c, approved_sha256: "a".repeat(64) } : c)) });
  const stories = base.stories.map((s) => (s.id === "s1-18-sn-a" ? { ...s, pipeline: null } : s));
  const short = buildSharedPieces({ ...base, stories })[0];
  assert.equal(short.format, "short");
  assert.deepEqual(short.assets.map((a) => [a.id, a.kind]), [["a-video", "video"]]);
  assert.equal(buildSharedPieces({ ...base, stories, decisions: [decision({})] })[0].decision, "approved");
});

test("the episode's listing is shown for information: only the video is decided on", () => {
  const p = buildSharedPieces(input({ decisions: [decision({})] }))[0];
  assert.equal(p.format, "episode");
  assert.deepEqual(p.assets.map((a) => [a.id, a.reviewable]), [["a-video", true], ["a-copy", false]]);
  assert.equal(p.decision, "approved", "the listing never holds the piece back");
});

test("their own notes and change requests show on the asset; an approval carries none", () => {
  const rows = [decision({ id: "n1", decision: "note", note: "Love the hook", decided_at: "2026-10-13T08:00:00Z" }), decision({ id: "n2", decision: "changes", note: "Spell Mamos right", decided_at: "2026-10-13T09:00:00Z" }), decision({ id: "n3" })];
  const v = buildSharedPieces(input({ decisions: rows }))[0].assets[0];
  assert.deepEqual(v.notes.map((n) => [n.id, n.kind, n.body, n.label]), [["n1", "note", "Love the hook", "v4"], ["n2", "changes", "Spell Mamos right", "v4"]]);
});

test("the publish gate follows the third party's latest decision on the final's bytes", () => {
  const media: HoldAsset[] = [{ id: "a-video", story_id: "s", kind: "video", sha256: "a".repeat(64), stage: "final" }];
  const d = (decision: string, at: string, sha = "a".repeat(64)): ThirdPartyDecision => ({ story_id: "s", stage: "final", party: "third_party", decision, decided_at: at, assets: [{ asset_id: "a-video", sha256: sha }] });
  assert.equal(thirdPartyApproved(media, [d("approved", "2026-10-13T10:00:00Z")]), true);
  assert.equal(thirdPartyApproved(media, [d("approved", "2026-10-13T10:00:00Z"), d("changes", "2026-10-13T11:00:00Z")]), false, "changes after an approval closes the gate");
  assert.equal(thirdPartyApproved(media, [d("changes", "2026-10-13T10:00:00Z"), d("approved", "2026-10-13T11:00:00Z")]), true);
  assert.equal(thirdPartyApproved(media, [d("approved", "2026-10-13T10:00:00Z", "b".repeat(64))]), false, "a new final needs a new sign-off");
  assert.equal(thirdPartyApproved(media, [{ ...d("approved", ""), decided_at: undefined }]), true, "a decision without a time still counts");
});

test("John is told what happened, in one line", () => {
  assert.equal(eventSubject({ party: example_approver, piece: "Robots", storyId: "s", kind: "approved", note: "" }), "example_approver / Example Series approved Robots");
  assert.equal(eventSubject({ party: example_approver, piece: "Robots", storyId: "s", kind: "changes", note: "x" }), "example_approver / Example Series asked for changes on Robots");
  assert.equal(eventSubject({ party: example_approver, piece: "Robots", storyId: "s", kind: "note", note: "x" }), "example_approver / Example Series left a note on Robots");
});

import { firstName, gmailUrl, shareMessage, whatIsReady, whatsappUrl } from "../lib/reviewer/share.ts";

test("share: the greeting, what is ready, and a message in John's voice", () => {
  assert.equal(firstName("example_approver / Example Series"), "example_approver");
  assert.equal(firstName("Example Series"), "Example Series", "no slash: the whole name, never just the first word");
  assert.deepEqual(whatIsReady(["Robots and the Mamos"]), { clause: "\"Robots and the Mamos\" is ready for your review", subject: "Robots and the Mamos" });
  assert.deepEqual(whatIsReady(["a", "b"], "example-shorts"), { clause: "the latest example shorts (2 pieces) are ready for your review", subject: "2 example shorts" });
  assert.equal(whatIsReady(["a", "b", "c"]).clause, "3 pieces are ready for your review");
  assert.equal(whatIsReady([]).clause, "your review page is ready", "no final yet: never a count of pieces still in production");
  const invite = shareMessage({ kind: "invite", party: example_approver, url: "https://x.test/invite/t", email: null }, whatIsReady(["Robots"]));
  assert.equal(invite.subject, "For your review: Robots");
  assert.match(invite.text, /^Hi example_approver, "Robots" is ready for your review:\nhttps:\/\/x\.test\/invite\/t\n\nOpen the link, then review each video/);
  const access = shareMessage({ kind: "access", party: example_approver, url: "https://x.test/shared", email: "t@x.test" }, whatIsReady([]));
  assert.match(access.text, /^Hi example_approver, your review page is ready:\n/);
  assert.match(access.text, /Sign in with the email and password you set up \(t@x\.test\)/);
  for (const m of [invite, access]) assert.doesNotMatch(m.text + m.subject, /[\u2013\u2014]/, "no en or em dashes");
});

test("share: WhatsApp and Gmail compose URLs carry the message", () => {
  assert.equal(whatsappUrl("+57 300-123 4567", "Hi & bye"), "https://wa.me/573001234567?text=Hi%20%26%20bye");
  assert.equal(whatsappUrl("", "Hi"), "https://wa.me/?text=Hi", "no number: WhatsApp asks who to send it to");
  const g = new URL(gmailUrl({ to: " t@x.test ", subject: "S", body: "line 1\nline 2", from: "user-f538cb95fc21@example.com" }));
  assert.equal(g.origin + g.pathname, "https://mail.google.com/mail/");
  assert.deepEqual([g.searchParams.get("view"), g.searchParams.get("to"), g.searchParams.get("su"), g.searchParams.get("body"), g.searchParams.get("authuser")],
    ["cm", "t@x.test", "S", "line 1\nline 2", "user-f538cb95fc21@example.com"]);
});
