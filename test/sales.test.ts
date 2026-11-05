// The pipeline dashboard (lib/sales, VIB-499): settings, money, pipeline metrics, outcomes, write-back, stage history,
// site traffic and the Twenty reads. Pure functions directly; provider reads through injected queries or a fetch mock.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";

const settingsMod = await import("../lib/sales/settings.ts");
const econ = await import("../lib/sales/economics.ts");
const metrics = await import("../lib/sales/metrics.ts");
const dealsMod = await import("../lib/sales/deals.ts");
const meetingsMod = await import("../lib/sales/meetings.ts");
const outcomes = await import("../lib/sales/outcomes.ts");
const writeback = await import("../lib/sales/writeback.ts");
const stages = await import("../lib/sales/stages.ts");
const web = await import("../lib/sales/web.ts");
const mailbox = await import("../lib/outreach/mailbox.ts");
const { TwentyError } = await import("../lib/twenty.ts");

const { DEFAULT_SALES_SETTINGS: S } = settingsMod;
type Deal = import("../lib/sales/deals.ts").SalesDeal;
type Milestone = import("../lib/sales/economics.ts").Milestone;

const deal = (d: Partial<Deal> & Pick<Deal, "id" | "stage">): Deal => ({
  name: d.id, company: null, domain: null, contact: null, fee: null, upside: null, deliveryCost: null, referralFee: null, owner: "JOHN", source: "NETWORK",
  partner: null, offer: "BUILD_SPRINT", lostReason: null, nextStep: "Call", nextStepAt: null, closeDate: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
  url: "https://crm.test/object/opportunity/" + d.id, ...d,
});
const ms = (m: Partial<Milestone> & Pick<Milestone, "id" | "opportunity_id" | "amount" | "currency">): Milestone => ({
  label: `m${m.id}`, due_on: null, invoiced_at: null, paid_at: null, paid_amount: null, payment_ref: null, note: null, ...m,
});
const NOW = new Date("2026-11-20T12:00:00Z");

/* ------------------------------------------------------------------------------------------------ settings */

test("settings: the defaults are valid, and a saved value merges over them key by key", () => {
  assert.deepEqual(settingsMod.salesSettingsProblems(S), []);
  const merged = settingsMod.mergeSalesSettings({ goalUsd: 12_000, fx: { GBP: 1.3 }, rates: { winFromQualified: 0.6 } });
  assert.equal(merged.goalUsd, 12_000);
  assert.equal(merged.fx.GBP, 1.3);
  assert.equal(merged.fx.EUR, S.fx.EUR, "an unsaved currency keeps its default");
  assert.equal(merged.fx.USD, 1, "USD is always 1");
  assert.equal(merged.rates.qualifiedFromMeeting, S.rates.qualifiedFromMeeting);
});

test("settings: problems name what is wrong", () => {
  const bad = { ...S, goalUsd: 0, taxReserve: 0.9, fx: { USD: 1, gbp: 1.3 }, rates: { ...S.rates, winFromQualified: 1.5 }, highIntentPaths: { "a.com": ["no-slash"] } };
  const p = settingsMod.salesSettingsProblems(bad);
  for (const word of ["goal", "tax reserve", "FX", "planning rate", "High-intent"]) assert.ok(p.some((x) => x.includes(word)), word);
});

test("settings: a saved row that fails validation falls back to the defaults with the reason", async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: { goalUsd: -5 } }, error: null }) }) }) }) };
  const r = await settingsMod.loadSalesSettings(db as never);
  assert.equal(r.source, "default");
  assert.ok(r.problems.length);
});

/* ------------------------------------------------------------------------------------------------ money */

test("money: USD conversion, and an unknown currency is null rather than guessed", () => {
  assert.equal(econ.toUsd({ amount: 100, currency: "GBP" }, S.fx), 135);
  assert.equal(econ.toUsd({ amount: 100, currency: "CHF" }, S.fx), null);
  assert.equal(econ.toUsd(null, S.fx), null);
});

test("money: take-home share is fee minus delivery and referral, over fee; 1 with no costs", () => {
  assert.equal(econ.takeHomeShare(deal({ id: "a", stage: "SIGNED", fee: { amount: 15_000, currency: "GBP" } }), S.fx), 1);
  const partner = deal({ id: "b", stage: "SIGNED", fee: { amount: 15_000, currency: "USD" }, deliveryCost: { amount: 9_750, currency: "USD" }, referralFee: { amount: 1_500, currency: "USD" } });
  assert.equal(econ.takeHomeShare(partner, S.fx), 0.25);
  const mixed = deal({ id: "c", stage: "SIGNED", fee: { amount: 10_000, currency: "GBP" }, deliveryCost: { amount: 13_500, currency: "USD" } });
  assert.equal(econ.takeHomeShare(mixed, S.fx), 0, "costs above the fee floor at zero");
});

test("money: a founder-delivered deal by hand ($20k, 50/25/25)", () => {
  const won = deal({ id: "p", stage: "SIGNED", fee: { amount: 20_000, currency: "USD" }, closeDate: "2026-11-10T00:00:00Z" });
  const list = [
    ms({ id: 1, opportunity_id: "p", amount: 10_000, currency: "USD", due_on: "2026-11-15", paid_at: "2026-11-16T10:00:00Z", paid_amount: 10_000 }),
    ms({ id: 2, opportunity_id: "p", amount: 5_000, currency: "USD", due_on: "2026-11-28" }),
    ms({ id: 3, opportunity_id: "p", amount: 5_000, currency: "USD", due_on: "2026-12-12" }),
  ];
  const nov = econ.monthMoney("2026-11", [won], list, S);
  assert.equal(nov.cashUsd, 10_000);
  assert.equal(nov.takeHomeUsd, 10_000);
  assert.equal(nov.signedUsd, 20_000);
  assert.equal(nov.scheduledContributionUsd, 5_000);
  const costs = { ...S, overheadUsd: 1_000, taxReserve: 0.25 };
  assert.equal(econ.monthMoney("2026-11", [won], list, costs).takeHomeUsd, 6_750, "(10,000 − 1,000) × 0.75");
  const g = econ.goalView([won], list, S, NOW);
  assert.equal(g.projectedThisMonthUsd, 15_000);
  assert.equal(g.nextTakeHomeUsd, 5_000);
  assert.equal(g.gapThisMonthUsd, 0);
  assert.equal(econ.toUsd({ amount: 6_000, currency: "GBP" }, S.fx), 8_100, "FX to the cent: 6,000 × 1.35 is 8,100, not 8,100.000000000001");
});

test("money: a proposal's planned payments are not scheduled cash; overhead makes an empty month negative", () => {
  const prop = deal({ id: "x", stage: "PROPOSAL", fee: { amount: 10_000, currency: "USD" } });
  const m = econ.monthMoney("2026-11", [prop], [ms({ id: 1, opportunity_id: "x", amount: 4_000, currency: "USD", due_on: "2026-11-30" })], { ...S, overheadUsd: 500 });
  assert.equal(m.scheduledContributionUsd, 0);
  assert.equal(m.takeHomeUsd, -500, "no tax relief on a loss, and no hiding it as zero");
});

test("money: amounts in a currency with no FX rate are listed, not counted", () => {
  const d = deal({ id: "z", stage: "SIGNED", fee: { amount: 1_000, currency: "CHF" } });
  const m = econ.monthMoney("2026-11", [d], [ms({ id: 1, opportunity_id: "z", amount: 1_000, currency: "CHF", paid_at: "2026-11-02T00:00:00Z", paid_amount: 1_000 })], S);
  assert.equal(m.cashUsd, 0);
  assert.deepEqual(m.unconverted, ["CHF"]);
});

test("money: the fee a month the goal needs grows with overhead and tax, and shrinks with the share", () => {
  assert.equal(econ.requiredFeeUsd(S, 1), 10_000);
  assert.equal(econ.requiredFeeUsd({ ...S, overheadUsd: 2_000, taxReserve: 0.2 }, 0.5), (10_000 / 0.8 + 2_000) / 0.5);
  assert.equal(econ.addMonths("2026-12", 1), "2027-01");
  assert.equal(econ.addMonths("2026-01", -3), "2025-10");
});

/* ------------------------------------------------------------------------------------------------ pipeline metrics */

test("pipeline: weighted pipeline and coverage; win rate stays the planning rate below 10 closed deals", () => {
  const deals = [
    deal({ id: "1", stage: "PROPOSAL", fee: { amount: 20_000, currency: "USD" } }),
    deal({ id: "2", stage: "QUALIFIED", fee: { amount: 10_000, currency: "USD" } }),
    deal({ id: "3", stage: "IDENTIFIED" }),
    deal({ id: "4", stage: "SIGNED", fee: { amount: 20_000, currency: "USD" }, closeDate: "2026-11-01T00:00:00Z", createdAt: "2026-10-02T00:00:00Z" }),
    deal({ id: "5", stage: "LOST" }),
  ];
  const h = metrics.pipelineHealth(deals, S, NOW);
  assert.equal(h.weightedUsd, 20_000 * 0.5 + 10_000 * 0.3);
  assert.equal(h.unpriced, 1);
  assert.equal(h.coverageNeedUsd, 20_000);
  assert.equal(h.coverage, 13_000 / 20_000);
  assert.deepEqual(h.winRate, { value: S.rates.winFromQualified, n: 1, measured: false }, "a lost lead that never qualified is not a lost sale");
  assert.equal(h.avgDealUsd, S.plannedDealUsd, "planning size until 3 won deals have fees");
  assert.equal(h.medianCycleDays, 30);
  assert.equal(h.qualifiedCount, 2);
});

test("pipeline: ten closed deals that qualified make the win rate measured; zero wins falls back to planning", () => {
  const closed = [...Array(4)].map((_, i) => deal({ id: `w${i}`, stage: "SIGNED" })).concat([...Array(6)].map((_, i) => deal({ id: `l${i}`, stage: "LOST" })));
  const hist = [...Array(6)].map((_, i) => ({ opportunity_id: `l${i}`, stage: "PROPOSAL" }));
  assert.deepEqual(metrics.pipelineHealth(closed, S, NOW, hist).winRate, { value: 0.4, n: 10, measured: true });
  assert.equal(metrics.pipelineHealth(closed, S, NOW).winRate.n, 4, "lost deals with no qualified history are left out");
  const allLost = [...Array(10)].map((_, i) => deal({ id: `x${i}`, stage: "LOST" }));
  const h = metrics.pipelineHealth(allLost, S, NOW, allLost.map((d) => ({ opportunity_id: d.id, stage: "QUALIFIED" })));
  assert.deepEqual(h.winRate, { value: S.rates.winFromQualified, n: 10, measured: false });
  const steps = metrics.reverseFunnel({ s: S, health: h, w: metrics.windowFor("30", NOW), actual: { won: 0, qualified: 0, meetings: 0, positive: 0, touches: 50 },
    measured: { positiveFromTouch: { value: 0, n: 50, measured: true }, qualifiedFromMeeting: { value: 1.5, n: 12, measured: true } } });
  assert.ok(steps.every((x) => Number.isFinite(x.requiredPerMonth)), "never infinite");
  assert.equal(steps.find((x) => x.key === "meetings")!.rate!.value, 1, "a ratio over 1 is capped");
});

test("needs action: late payments first, then missing next steps, owners, sources, amounts and milestones", () => {
  const deals = [
    deal({ id: "a", stage: "PROPOSAL", nextStep: null }),
    deal({ id: "b", stage: "QUALIFIED", nextStepAt: "2026-11-01T00:00:00Z", owner: null, source: null }),
    deal({ id: "c", stage: "SIGNED", fee: null, closeDate: "2026-11-15T00:00:00Z" }),
    deal({ id: "d", stage: "SIGNED", fee: { amount: 1, currency: "USD" }, closeDate: "2025-01-01T00:00:00Z" }),
    deal({ id: "e", stage: "SIGNED", fee: { amount: 1, currency: "USD" }, closeDate: "2026-11-01T00:00:00Z" }),
  ];
  const a = metrics.needsAction(deals, [ms({ id: 9, opportunity_id: "e", amount: 1, currency: "USD", due_on: "2026-11-10" })], NOW);
  const keys = a.map((x) => x.key);
  assert.equal(keys[0], "overdue-pay:9");
  for (const k of ["no-step:a", "late-step:b", "no-owner:b", "no-source:b", "no-fee:c", "no-milestones:c"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes("no-milestones:d"), "an old won deal is not nagged for milestones");
  assert.ok(!keys.includes("no-milestones:e"), "a deal with a milestone is fine");
  assert.equal(a.find((x) => x.key === "late-step:b")!.tone, "bad", "19 days late is bad");
});

test("desk: first touches, replies and labels by owner and track; rates wait for 10 sends", () => {
  const W = metrics.windowFor("30", NOW);
  const row = (o: Partial<import("../lib/sales/metrics.ts").DeskRow>) => ({ track: "client", route: "email", email_sent_at: null, email_sent_by: null, follow_up_sent_at: null,
    email_replied_at: null, email_bounced_at: null, reply_sentiment: null, linkedin_sent_at: null, linkedin_sent_by: null, linkedin_status: "none", ...o });
  const rows = [
    ...[...Array(10)].map((_, i) => row({ email_sent_at: `2026-11-${10 + i}T00:00:00Z`, email_sent_by: "john@hq.test" })),
    row({ email_sent_at: "2026-11-05T00:00:00Z", email_sent_by: "abe@hq.test", email_replied_at: "2026-11-06T00:00:00Z", reply_sentiment: "positive" }),
    row({ email_sent_at: "2026-11-05T00:00:00Z", email_sent_by: "john@hq.test", email_replied_at: "2026-11-07T00:00:00Z" }),
    row({ email_sent_at: "2026-11-05T00:00:00Z", email_sent_by: "john@hq.test", email_bounced_at: "2026-11-05T01:00:00Z" }),
    row({ track: "guest", email_sent_at: "2026-11-05T00:00:00Z" }),
    row({ email_sent_at: "2026-09-01T00:00:00Z" }),
  ];
  const ownerOf = (by: string | null) => (by === "abe@hq.test" ? "ABE" as const : "JOHN" as const);
  const john = metrics.deskStats(rows, W, ownerOf, "JOHN", "client");
  assert.equal(john.firstTouches, 12);
  assert.equal(john.replies, 1);
  assert.equal(john.unlabeled, 1);
  assert.equal(john.bounces, 1);
  assert.equal(john.replyRate, 1 / 12);
  const abe = metrics.deskStats(rows, W, ownerOf, "ABE", "client");
  assert.deepEqual([abe.firstTouches, abe.positive, abe.replyRate], [1, 1, null]);
  assert.equal(metrics.deskStats(rows, W, ownerOf, null, "guest").firstTouches, 1);
});

test("LinkedIn, meetings and site days roll up per window and owner", () => {
  const W = metrics.windowFor("30", NOW);
  const li = metrics.linkedinStats(
    [{ owner: "JOHN", connected_on: "2026-11-10", icp: true, person_id: null }, { owner: "JOHN", connected_on: "2026-09-10", icp: true, person_id: null }],
    [{ owner: "JOHN", first_at: "2026-11-12T00:00:00Z", last_at: "2026-11-13T00:00:00Z", started_by_owner: false, two_way: true, icp: true, person_id: null }], W, "JOHN");
  assert.deepEqual(li, { connections: 1, icpConnections: 1, conversations: 1, twoWay: 1, icpTwoWay: 1, inbound: 1 });
  const mt = (id: string, at: string, kind: string, owner: "JOHN" | "ABE" = "JOHN") => ({ id, name: id, at, owner, kind, company: null, opportunityId: id === "d1" ? "o" : null, opportunityStage: null, url: "" });
  const m = metrics.meetingStats([mt("d1", "2026-11-10T00:00:00Z", "DISCOVERY"), mt("c1", "2026-11-11T00:00:00Z", "CLIENT"), mt("u1", "2026-11-25T00:00:00Z", "DISCOVERY"), mt("a1", "2026-11-11T00:00:00Z", "DISCOVERY", "ABE")], W, NOW, "JOHN");
  assert.deepEqual([m.held, m.discovery, m.client, m.discoveryWithDeal, m.upcoming.length], [2, 1, 1, 1, 1]);
  const days = metrics.webStats([
    { site: "a.test", day: "2026-11-18", visitors: 5, pageviews: 9, high_intent: 2, paths: [{ key: "/", n: 4 }], referrers: [{ key: "google.com", n: 2 }], utm: [] },
    { site: "a.test", day: "2026-11-19", visitors: 7, pageviews: 8, high_intent: 1, paths: [{ key: "/", n: 3 }, { key: "/contact", n: 1 }], referrers: [], utm: [] },
    { site: "a.test", day: "2026-09-01", visitors: 99, pageviews: 99, high_intent: 9, paths: [], referrers: [], utm: [] },
  ], W);
  assert.deepEqual([days[0].visitors, days[0].highIntent, days[0].days, days[0].paths[0]], [12, 3, 2, { key: "/", n: 7 }]);
  assert.ok(metrics.isHighIntent("/contact", ["/contact"]) && metrics.isHighIntent("/ai-build-sprint/faq", ["/ai-build-sprint"]) && !metrics.isHighIntent("/contactless", ["/contact"]));
});

test("reverse funnel: from the goal back to first touches at the rates in force", () => {
  const W = metrics.windowFor("30", NOW);
  const health = metrics.pipelineHealth([], S, NOW);
  const steps = metrics.reverseFunnel({ s: S, health, w: W, actual: { won: 1, qualified: 2, meetings: 3, positive: 4, touches: 100 }, measured: {} });
  const req = Object.fromEntries(steps.map((x) => [x.key, x.requiredPerMonth]));
  const won = 10_000 / S.plannedDealUsd;
  assert.equal(req.won, won);
  assert.equal(req.qualified, won / 0.5);
  assert.equal(req.meetings, won / 0.5 / 0.65);
  assert.ok(Math.abs(req.touches - won / 0.5 / 0.65 / 0.5 / 0.02) < 1e-9);
  assert.equal(steps[0].actualPerMonth, 1);
  const q = metrics.windowFor("qtd", NOW);
  assert.equal(q.start.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("reached in window: stage history first, createdAt for deals history has never seen", () => {
  const W = metrics.windowFor("30", NOW);
  const deals = [deal({ id: "a", stage: "PROPOSAL" }), deal({ id: "b", stage: "QUALIFIED", createdAt: "2026-11-02T00:00:00Z" }), deal({ id: "c", stage: "QUALIFIED", createdAt: "2026-01-02T00:00:00Z" })];
  const hist = [{ opportunity_id: "a", stage: "QUALIFIED", first_seen_at: "2026-11-05T00:00:00Z" }];
  assert.deepEqual([...metrics.reachedInWindow(deals, hist, ["QUALIFIED", "PROPOSAL"], W)].sort(), ["a", "b"]);
});

/* ------------------------------------------------------------------------------------------------ Twenty reads */

test("deals: pipeline fields map; a zero amount is unset; a missing field falls back to the standard read", async () => {
  const node = { id: "o1", name: "Harbor Labs", stage: "PROPOSAL", closeDate: null, createdAt: "2026-11-05T00:00:00Z", updatedAt: null,
    amount: { amountMicros: 18_000_000_000, currencyCode: "USD" }, company: { name: "Harbor Labs", domainName: { primaryLinkUrl: "https://www.harbor.test" } }, pointOfContact: null,
    oppOwner: "JOHN", oppSource: "PARTNER", oppPartner: "Partner", oppOffer: "BUILD_SPRINT", oppUpsideAmount: { amountMicros: 30_000_000_000, currencyCode: "USD" },
    oppDeliveryCost: { amountMicros: 0, currencyCode: "GBP" }, oppReferralFee: null, oppNextStep: "MOU", oppNextStepAt: null, oppLostReason: null };
  const queries: string[] = [];
  const ok = await dealsMod.salesDeals({ query: async (q) => { queries.push(q); return { opportunities: { edges: [{ node }] } }; } });
  assert.equal(ok.fields, "pipeline");
  const d = ok.deals[0];
  assert.deepEqual([d.owner, d.source, d.domain, d.fee, d.upside, d.deliveryCost], ["JOHN", "PARTNER", "harbor.test", { amount: 18_000, currency: "USD" }, { amount: 30_000, currency: "USD" }, null]);
  let calls = 0;
  const fallback = await dealsMod.salesDeals({ query: async (q) => {
    calls++;
    if (q.includes("oppOwner")) throw new TwentyError("missing", [{ message: 'Cannot query field "oppOwner" on type "Opportunity".' }]);
    return { opportunities: { edges: [{ node: { ...node, oppOwner: undefined } }] } };
  } });
  assert.deepEqual([fallback.fields, calls, fallback.deals[0].owner], ["standard", 2, null]);
  await assert.rejects(dealsMod.salesDeals({ query: async () => { throw new Error("down"); } }), /down/);
});

test("meetings: the ledger maps; a missing object reads as not installed", async () => {
  const r = await meetingsMod.salesMeetings(NOW, { query: async () => ({ meetings: { edges: [{ node: { id: "m", name: "Call", mtgAt: "2026-11-04T09:00:00Z", mtgOwner: "JOHN", mtgKind: "CLIENT", mtgCompany: { name: "Pikl" }, mtgOpportunity: null } }] } }) });
  assert.ok(r.installed && r.meetings[0].kind === "CLIENT" && r.meetings[0].company === "Pikl");
  const none = await meetingsMod.salesMeetings(NOW, { query: async () => { throw new TwentyError("x", [{ message: 'Cannot query field "meetings" on type "Query".' }]); } });
  assert.equal(none.installed, false);
});

/* ------------------------------------------------------------------------------------------------ outcomes, write-back, stages */

test("outcomes: a sent thread stamps a forgotten send; a reply and a bounce stamp once; nothing moves backwards", () => {
  const conv = (o: Partial<import("../lib/outreach/mailbox.ts").Conversation>) => ({ id: "t", draftId: "d", company: "", subject: "", status: "awaiting-reply" as const, unread: false, lastAt: "", snippet: "", ...o });
  const draft = (o: Partial<import("../lib/sales/outcomes.ts").OutcomeDraft> = {}) => ({ id: "d", subject: "s", prospect: {}, email_status: "none" as const, email_sent_at: null, email_sent_by: null, email_replied_at: null, email_bounced_at: null, ...o });
  assert.deepEqual(outcomes.outcomePatch(conv({ sentAt: "2026-11-01T00:00:00.000Z" }), draft(), "HQ@x.test"),
    { email_sent_at: "2026-11-01T00:00:00.000Z", email_sent_by: "hq@x.test", email_status: "sent" });
  assert.deepEqual(outcomes.outcomePatch(conv({ sentAt: "a", status: "reply", replyAt: "2026-11-02T00:00:00.000Z" }), draft({ email_status: "sent", email_sent_at: "x" }), "hq@x.test"),
    { email_replied_at: "2026-11-02T00:00:00.000Z", email_status: "replied" });
  assert.deepEqual(outcomes.outcomePatch(conv({ status: "delivery-failure", failedAt: "f" }), draft({ email_status: "sent", email_sent_at: "x" }), "hq@x.test"), { email_bounced_at: "f" });
  assert.deepEqual(outcomes.outcomePatch(conv({ status: "reply", replyAt: "2026-11-03T00:00:00.000Z" }), draft({ email_status: "replied", email_sent_at: "x", email_replied_at: "2026-11-02T00:00:00.000Z" }), "hq@x.test"), {});
  // Labeled before the sync stored it: the label-time date gives way to Gmail's earlier one, and a "sent" status advances.
  assert.deepEqual(outcomes.outcomePatch(conv({ status: "reply", replyAt: "2026-10-30T00:00:00.000Z" }), draft({ email_status: "sent", email_sent_at: "x", email_replied_at: "2026-11-06T00:00:00.000Z" }), "hq@x.test"),
    { email_replied_at: "2026-10-30T00:00:00.000Z", email_status: "replied" });
});

test("inbox matching exposes when the email left, the first reply and a failure", () => {
  const msg = (id: string, at: number, from: string, to: string, labels: string[] = [], extra: Record<string, string> = {}) => ({ id, internalDate: String(at), labelIds: labels,
    payload: { headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: "Hello" }, ...Object.entries(extra).map(([name, value]) => ({ name, value }))] } });
  const drafts = [{ id: "d1", subject: "Hello", email_sent_at: null, prospect: { email: "p@co.test", company: "Co" } }];
  const t = { id: "t1", messages: [msg("1", 1_000, "hq@x.test", "p@co.test", ["SENT"]), msg("2", 2_000, "p@co.test", "hq@x.test"), msg("3", 3_000, "p@co.test", "hq@x.test")] };
  const c = mailbox.matchConversation(t, drafts, "hq@x.test")!;
  assert.deepEqual([c.status, c.sentAt, c.replyAt], ["reply", new Date(1_000).toISOString(), new Date(2_000).toISOString()]);
  const bounce = mailbox.matchConversation({ id: "t2", messages: [msg("1", 1_000, "hq@x.test", "p@co.test", ["SENT"]), msg("2", 2_000, "MAILER-DAEMON@mail.test", "hq@x.test")] }, drafts, "hq@x.test")!;
  assert.deepEqual([bounce.status, bounce.failedAt], ["delivery-failure", new Date(2_000).toISOString()]);
});

test("write-back: the latest send per Twenty person since the cursor, ignoring malformed ids", () => {
  const P = "00000000-0000-4000-8000-000000000001";
  const m = writeback.latestSends([
    { email_sent_at: "2026-11-02T00:00:00Z", prospect: { twenty_person_id: P } },
    { email_sent_at: "2026-11-04T00:00:00Z", prospect: { twenty_person_id: P } },
    { email_sent_at: "2026-11-04T00:00:00Z", prospect: { twenty_person_id: "not-a-uuid" } },
    { email_sent_at: "2026-10-01T00:00:00Z", prospect: { twenty_person_id: "00000000-0000-4000-8000-000000000002" } },
  ], "2026-11-01T00:00:00Z");
  assert.deepEqual([...m], [[P, "2026-11-04T00:00:00Z"]]);
});

test("stage history: a new deal is dated at its last change, a move at now, a known stage not again", () => {
  const rows = stages.newStageRows([
    { id: "a", stage: "PROPOSAL", updatedAt: "2026-10-20T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
    { id: "b", stage: "SIGNED", updatedAt: "2026-11-19T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
    { id: "c", stage: "QUALIFIED", updatedAt: null, createdAt: "2026-10-01T00:00:00Z" },
  ], [{ opportunity_id: "b", stage: "PROPOSAL", first_seen_at: "x" }, { opportunity_id: "c", stage: "QUALIFIED", first_seen_at: "y" }], NOW);
  assert.deepEqual(rows, [
    { opportunity_id: "a", stage: "PROPOSAL", first_seen_at: "2026-10-20T00:00:00Z" },
    { opportunity_id: "b", stage: "SIGNED", first_seen_at: NOW.toISOString() },
  ]);
});

/* ------------------------------------------------------------------------------------------------ site traffic */

let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

test("web: config is validated, and days run from the newest stored day to yesterday", () => {
  assert.equal(web.webConfig({}), null);
  assert.throws(() => web.webConfig({ VERCEL_ANALYTICS_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_ANALYTICS_SITES: '[{"site":"x","projectId":"p"}]' }), /list of/);
  assert.deepEqual(web.webConfig({ VERCEL_ANALYTICS_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_ANALYTICS_SITES: '[{"site":"a.test","projectId":"prj_1"}]' })?.sites, [{ site: "a.test", projectId: "prj_1" }]);
  assert.deepEqual(web.daysToFetch("2026-11-17", NOW), ["2026-11-18", "2026-11-19"]);
  assert.deepEqual(web.daysToFetch("2026-11-19", NOW), []);
  const back = web.daysToFetch(null, NOW, 30, 10);
  assert.deepEqual([back.length, back[0]], [10, "2026-10-21"]);
});

test("web: a day reads the count with full bounds and the breakdowns to 23:00, and sums high-intent pages", async () => {
  const API = "https://api.vercel.com/v1/query/web-analytics/visits";
  mock = installFetchMock([
    { url: `${API}/count`, json: { data: { visitors: 7, pageviews: 9 } } },
    { url: `${API}/aggregate`, json: { data: [{ requestPath: "/", visitors: 5, pageviews: 6 }, { requestPath: "/contact", visitors: 2, pageviews: 2 }, { requestPath: "Others", visitors: 1, pageviews: 1 }] } },
  ]);
  const cfg = { token: "t", teamId: "team_1", sites: [{ site: "a.test", projectId: "prj_1" }] };
  const row = await web.fetchDay(cfg, cfg.sites[0], "2026-11-04", ["/contact"]);
  assert.deepEqual([row.visitors, row.pageviews, row.high_intent, row.paths.length], [7, 9, 2, 2]);
  const urls = mock.calls.map((c) => new URL(c.url));
  const count = urls.find((u) => u.pathname.endsWith("/count"))!;
  assert.deepEqual([count.searchParams.get("since"), count.searchParams.get("until"), count.searchParams.get("projectId")], ["2026-11-04T00:00:00Z", "2026-11-05T00:00:00.000Z", "prj_1"]);
  const agg = urls.find((u) => u.pathname.endsWith("/aggregate") && u.searchParams.get("by") === "requestPath")!;
  assert.equal(agg.searchParams.get("until"), "2026-11-04T23:00:00.000Z");
  assert.ok(mock.calls.every((c) => c.headers.authorization === "Bearer t"));
});

/* ------------------------------------------------------------------------------------------------ Wise reconcile */

test("reconcile: a credit pays the closest milestone in its currency once; fees under 5% still match; too early or foreign does not", async () => {
  const { matchCredits } = await import("../lib/sales/reconcile.ts");
  const list = [
    ms({ id: 1, opportunity_id: "p", amount: 5_000, currency: "GBP", due_on: "2026-11-15" }),
    ms({ id: 2, opportunity_id: "p", amount: 2_500, currency: "GBP", due_on: "2026-12-15" }),
    ms({ id: 3, opportunity_id: "q", amount: 3_000, currency: "USD", due_on: "2026-11-01", paid_at: "2026-11-02T00:00:00Z", paid_amount: 3_000 }),
  ];
  const credit = (id: string, date: string, currency: string, amount: number) => ({ id, date, currency, amount, description: "" });
  const r = matchCredits(list, [
    credit("c1", "2026-11-16", "GBP", 4_990), credit("c2", "2026-11-16", "GBP", 5_000), credit("c3", "2026-10-01", "GBP", 2_500),
    credit("c4", "2026-11-20", "EUR", 2_500), credit("c5", "2026-11-03", "USD", 3_000), credit("c6", "2026-11-05", "GBP", -10),
  ]);
  assert.deepEqual(r.matches.map((m) => [m.milestone.id, m.credit.id, m.shortfall]), [[1, "c2", 0]]);
  assert.deepEqual(r.unmatched.map((c) => c.id), ["c1", "c3", "c4", "c5"]);
  const fees = matchCredits([list[1]], [credit("f", "2026-12-14", "GBP", 2_380)]);
  assert.deepEqual(fees.matches.map((m) => m.shortfall), [120]);
});

test("reconcile: a second run never spends a credit an earlier run recorded", async () => {
  const { matchCredits } = await import("../lib/sales/reconcile.ts");
  const credit = { id: "C1", date: "2026-11-02", currency: "GBP", amount: 7_500, description: "" };
  const deposit = ms({ id: 1, opportunity_id: "p", amount: 7_500, currency: "GBP", due_on: "2026-11-01" });
  const final = ms({ id: 2, opportunity_id: "p", amount: 7_500, currency: "GBP", due_on: "2026-11-08" });
  const first = matchCredits([deposit, final], [credit]);
  assert.deepEqual(first.matches.map((m) => m.milestone.id), [1]);
  const paid = { ...deposit, paid_at: "2026-11-02T12:00:00Z", paid_amount: 7_500, payment_ref: "wise:C1" };
  const second = matchCredits([paid, final], [credit]);
  assert.deepEqual([second.matches.length, second.unmatched.length], [0, 0]);
});
