import { test } from "node:test";
import assert from "node:assert/strict";
import { emailOwners } from "../lib/origami/identity.ts";
import type { TwentyReader } from "../lib/twenty.ts";

test("RAW_JSON LIKE searches include mixed-case additional emails and exact filtering discards false hits", async () => {
  const people = [
    { id: "one", emails: { primaryEmail: "ana@prospect.test", additionalEmails: [] }, gtmMarketingConsent: null },
    { id: "two", emails: { primaryEmail: null, additionalEmails: ["ANA@PROSPECT.TEST"] }, gtmMarketingConsent: null },
    { id: "three", emails: { primaryEmail: null, additionalEmails: ["bob@different.test"] }, gtmMarketingConsent: null },
  ];
  const reader = { all: async (_object: unknown, _fields: unknown, filter: { or: Array<{ emails: Record<string, Record<string, string>> }> }) => {
    const pattern = filter.or[1].emails.additionalEmails.like;
    const re = new RegExp(`^${[...pattern].map((c) => c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`);
    return people.filter((p) => p.emails.primaryEmail?.toLowerCase() === "ana@prospect.test" || re.test(JSON.stringify(p.emails.additionalEmails)));
  } } as unknown as TwentyReader;
  assert.deepEqual((await emailOwners(reader, "ana@prospect.test")).map((p) => p.id), ["one", "two"]);
});
