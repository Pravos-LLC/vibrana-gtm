// Email rules and health (VIB-511): failure reports per recipient, the reply rules, DNS checks, DMARC aggregate reports
// and alert recipients. Synthetic domains and addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { classifyStatus, newText, parseDeliveryStatus, replyRule } from "../lib/email/rules.ts";
import { alertRecipients, checkDomain, healthDomains, parseDmarcAggregate } from "../lib/email/health.ts";

const DSN = `Reporting-MTA: dns; mx.example.test
Arrival-Date: Thu, 6 Nov 2026 10:00:00 +0000

Final-Recipient: rfc822; ana@prospect.test
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.

Final-Recipient: rfc822; <Bo@Prospect.test>
Action: delayed
Status: 4.4.7
Diagnostic-Code: smtp; 421 try again later

Final-Recipient: rfc822; cy@prospect.test
Action: failed
Status: 5.7.26
Diagnostic-Code: smtp; 550-5.7.26 Unauthenticated email is not accepted
 due to DMARC policy

Final-Recipient: rfc822; dee@prospect.test
Action: failed
Status: 5.2.2
Diagnostic-Code: smtp; 552 mailbox full
`;

test("a failure report names each recipient's own outcome; temporary and sender problems never invalidate the contact", () => {
  assert.deepEqual(parseDeliveryStatus(DSN), [
    { address: "ana@prospect.test", delivery: "failed_invalid_address", status: "5.1.1" },
    { address: "bo@prospect.test", delivery: "delayed", status: "4.4.7" },
    { address: "cy@prospect.test", delivery: "failed_policy", status: "5.7.26" },
    { address: "dee@prospect.test", delivery: "delayed", status: "5.2.2" },
  ]);
  assert.equal(classifyStatus("5.4.1", "failed", "550 blocked by spam filter"), "failed_policy", "policy wording beats a generic 5.x");
  assert.equal(classifyStatus("5.0.0", "failed", "550 something"), "failed_unclassified");
  assert.equal(classifyStatus("5.1.1", "failed", "550 5.1.1 authentication required"), "failed_policy", "sender wording wins over an address status");
  assert.equal(classifyStatus("5.1.0", "failed", "550 Unauthenticated sender rejected"), "failed_policy");
  assert.equal(classifyStatus(null, null, ""), null, "no status is not applied");
  assert.deepEqual(parseDeliveryStatus("Reporting-MTA: dns; x\n\nAction: failed\nStatus: 5.1.1\n"), [], "no recipient, nothing to apply");
});

test("only the new text of a reply counts: a quoted unsubscribe footer is not an opt-out", () => {
  const quoted = "Thanks, interested. Can we talk Tuesday?\n\nOn Mon, Nov 3, 2026 at 9:00 AM Abe <a@hq.test> wrote:\n> Hi Ana\n> Reply unsubscribe to stop these emails.";
  assert.equal(newText(quoted), "Thanks, interested. Can we talk Tuesday?");
  assert.deepEqual(replyRule(quoted, false), { intent: "uncertain", opt_out: "none" });
  assert.deepEqual(replyRule("Please remove me from your list.", false), { intent: "uncertain", opt_out: "uncertain" }, "a possible opt-out is held for a person");
  assert.deepEqual(replyRule("Thanks, interested.\n\nOn Thu, Nov 6, 2026, Sender\n<sender@hq.test> wrote:\nReply unsubscribe to stop these emails.", false),
    { intent: "uncertain", opt_out: "none" }, "a wrapped attribution line still ends the new text");
  assert.deepEqual(replyRule("On second thought, please remove me.", false), { intent: "uncertain", opt_out: "uncertain" }, "a sentence starting with On is not an attribution");
  assert.deepEqual(replyRule("No need to remove me, just not now.", false), { intent: "uncertain", opt_out: "none" });
  assert.deepEqual(replyRule("I am out of the office until Monday.", true), { intent: "auto_reply", opt_out: "none" });
  assert.deepEqual(replyRule("Auto: unsubscribe me", true), { intent: "uncertain", opt_out: "uncertain" }, "an automatic opt-out is still reviewed");
});

const resolver = (records: Record<string, string[][]>, mx = true) => ({
  mx: async (d: string) => (mx && d === "hq.test" ? [{ exchange: "mx.hq.test", priority: 1 }] : []),
  txt: async (d: string) => { if (!(d in records)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return records[d]; },
});

test("DNS: MX, one SPF record, a DMARC policy and the DKIM key; each missing record is named", async () => {
  const ok = await checkDomain("hq.test", "google", resolver({ "hq.test": [["v=spf1 include:_spf.example.test ~all"]], "_dmarc.hq.test": [["v=DMARC1; p=none; rua=mailto:r@x.test"]], "google._domainkey.hq.test": [["v=DKIM1; k=rsa; p=", "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"]] }));
  assert.deepEqual(ok, { domain: "hq.test", mx: true, spf: true, dmarc: "none", dkim: true, problems: [] });
  const bad = await checkDomain("hq.test", "google", resolver({ "hq.test": [["v=spf1 a ~all"], ["v=spf1 mx ~all"]] }, false));
  assert.deepEqual(bad.problems, ["no MX record", "more than one SPF record", "no DMARC policy", "no DKIM key at selector google"]);
  assert.deepEqual(healthDomains({ EMAIL_HEALTH_DOMAINS: "HQ.test:google, other.test, not a domain" }), [{ domain: "hq.test", selector: "google" }, { domain: "other.test", selector: null }]);
});

const XML = `<?xml version="1.0"?><feedback><report_metadata><org_name>reporter.test</org_name><report_id>r-1</report_id>
<date_range><begin>1762387200</begin><end>1762473599</end></date_range></report_metadata>
<policy_published><domain>hq.test</domain><p>none</p></policy_published>
<record><row><source_ip>192.0.2.1</source_ip><count>9</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row></record>
<record><row><source_ip>198.51.100.7</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row></record>
</feedback>`;

test("a DMARC aggregate report becomes totals and per-source counts, raw or gzipped; junk is refused", () => {
  const r = parseDmarcAggregate(XML)!;
  assert.deepEqual({ ...r, report_key: r.report_key.length }, { report_key: 64, reporter: "reporter.test", domain: "hq.test", begin_at: "2025-11-06T00:00:00.000Z", end_at: "2025-11-06T23:59:59.000Z",
    messages: 10, dmarc_pass: 9, dkim_aligned: 9, spf_aligned: 0, sources: [{ ip: "192.0.2.1", count: 9, dkim: "pass", spf: "fail" }, { ip: "198.51.100.7", count: 1, dkim: "fail", spf: "fail" }] });
  assert.equal(parseDmarcAggregate(gzipSync(Buffer.from(XML)))!.report_key, r.report_key, "the same report is the same key");
  assert.equal(parseDmarcAggregate("<html>nope</html>"), null);
});

test("alerts go to EMAIL_ALERT_TO when set (both owners), else to the cron's report recipients", () => {
  assert.deepEqual(alertRecipients("ops@hq.test", { EMAIL_ALERT_TO: "a@hq.test, b@hq.test" }), ["a@hq.test", "b@hq.test"]);
  assert.deepEqual(alertRecipients("ops@hq.test", {}), ["ops@hq.test"]);
});
