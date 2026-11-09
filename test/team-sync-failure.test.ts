// The sync's last_error names where it stopped without quoting data (lib/team/mailbox.ts failedStep). Synthetic errors only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failedStep } from "../lib/team/mailbox.ts";
import { DbError, must } from "../lib/db.ts";

const dbFail = (step: string, message: string) => { try { must({ data: null, error: { message } }, step); } catch (e) { return e; } throw new Error("must did not throw"); };

test("a database step and its violated constraint are named; the database message is not", () => {
  const e = dbFail("save mail events", 'new row for relation "gtm_team_mail_events" violates check constraint "gtm_team_mail_events_gmail_message_id_check"');
  assert.ok(e instanceof DbError);
  assert.equal((e as Error).message.startsWith("save mail events: "), true, "the message keeps its old shape for logs and tests");
  assert.equal(failedStep(e), 'at "save mail events", check constraint gtm_team_mail_events_gmail_message_id_check');
  assert.equal(failedStep(dbFail("save attempts", 'invalid input syntax for type uuid: "ana@prospect.test"')), 'at "save attempts"');
});

test("only a label set in code is shown; anything else is its error type, never its text", () => {
  assert.equal(failedStep(new Error("jane doe: lookup failed")), "Error", "a provider message shaped like a label is not a label");
  assert.equal(failedStep(new TypeError("fetch failed for ana@prospect.test")), "TypeError");
  assert.equal(failedStep(new DbError("Ana <ana@prospect.test>", "x")), 'at "a database step"');
  assert.equal(failedStep("a string"), "unknown error");
  const odd = new Error("x"); odd.name = "Weird name with ana@prospect.test";
  assert.equal(failedStep(odd), "unknown error");
});
