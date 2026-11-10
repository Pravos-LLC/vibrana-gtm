import type { TwentyReader } from "../twenty";
import { personEmails } from "../team/restrictions";

/** A complete case-insensitive superset for Twenty's case-sensitive RAW_JSON additionalEmails LIKE filter. */
export async function emailOwners(reader: TwentyReader, email: string) {
  if (!/^[a-z0-9@.+_%-]+$/i.test(email)) throw new Error("Origami email cannot be safely checked for CRM uniqueness; review required");
  const broad = [...email].map((c) => /[a-z_%]/i.test(c) ? "_" : c).join("");
  type Row = { id: string; emails: { primaryEmail: string | null; additionalEmails?: unknown } | null; gtmMarketingConsent: string | null };
  const rows = await reader.all<Row>("people", "id emails { primaryEmail additionalEmails } gtmMarketingConsent", { or: [
    { emails: { primaryEmail: { ilike: email } } }, { emails: { additionalEmails: { like: `%${broad}%` } } },
  ] }, "PersonFilterInput", 100, 10000);
  return rows.filter((r) => personEmails(r).includes(email));
}
