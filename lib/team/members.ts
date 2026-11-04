// Team members whose GTM work the cockpit measures (/performance/team).
//
// Who a member is in each system comes from one production-only env var, GTM_TEAM_MEMBERS, never from code: this repo
// is public, so real names, addresses, Twenty member ids and API key names stay out of it. In sample mode a fake member
// stands in so the page renders.
//
// GTM_TEAM_MEMBERS is a JSON array:
//   [{ "code": "ABE", "label": "Abe", "authEmail": "<cockpit login>", "workspaceMemberId": "<Twenty workspace member id>",
//      "apiKeyNames": ["<Twenty API key name>"], "mailboxes": ["<sending address>"] }]
//
// Attribution in Twenty: a row created in the app records `createdBy.source = MANUAL` and the workspace member; a row
// written through an API key records `source = API` and the key's name (verified against production, 2026-11-04).
// A member's rows are those with their workspace member id, or an API row under one of their key names.
import { contentMode } from "../content-overlay.mjs";

export type TeamMember = {
  code: string;
  label: string;
  authEmail: string;
  workspaceMemberId: string | null;
  apiKeyNames: string[];
  mailboxes: string[];
};

export type CreatedBy = { source?: string | null; name?: string | null; workspaceMemberId?: string | null } | null | undefined;

// Strict on purpose: authEmail is interpolated into a PostgREST filter on the team page.
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,19}$/;

export const SAMPLE_MEMBERS: TeamMember[] = [{
  code: "SAMPLE", label: "Sample teammate", authEmail: "teammate@example.com", workspaceMemberId: null,
  apiKeyNames: ["sample-agent"], mailboxes: ["teammate@example.com"],
}];

/** Parses GTM_TEAM_MEMBERS. Anything malformed throws with the reason: a half-read config would silently mis-attribute. */
export function parseMembers(raw: string | undefined): TeamMember[] {
  if (!raw || !raw.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("GTM_TEAM_MEMBERS is not valid JSON"); }
  if (!Array.isArray(value)) throw new Error("GTM_TEAM_MEMBERS must be a JSON array");
  const seen = new Set<string>();
  return value.map((v, i) => {
    const m = v as Record<string, unknown>;
    const where = `GTM_TEAM_MEMBERS[${i}]`;
    if (!m || typeof m !== "object") throw new Error(`${where} must be an object`);
    const code = String(m.code ?? "");
    if (!CODE.test(code)) throw new Error(`${where}.code must be uppercase letters, digits or _ (2 to 20)`);
    if (seen.has(code)) throw new Error(`${where}.code ${code} is repeated`);
    seen.add(code);
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 60) : code;
    const authEmail = String(m.authEmail ?? "").trim().toLowerCase();
    if (!EMAIL.test(authEmail)) throw new Error(`${where}.authEmail must be an email address`);
    const wm = m.workspaceMemberId == null || m.workspaceMemberId === "" ? null : String(m.workspaceMemberId);
    if (wm && !UUID.test(wm)) throw new Error(`${where}.workspaceMemberId must be a UUID`);
    const list = (k: string) => (Array.isArray(m[k]) ? (m[k] as unknown[]) : m[k] == null ? [] : null);
    const keys = list("apiKeyNames"), boxes = list("mailboxes");
    if (!keys || keys.some((k) => typeof k !== "string" || !k.trim() || k.length > 100)) throw new Error(`${where}.apiKeyNames must be a list of key names`);
    if (!boxes || boxes.some((b) => typeof b !== "string" || !EMAIL.test(b.trim()))) throw new Error(`${where}.mailboxes must be a list of email addresses`);
    if (!wm && !keys.length) throw new Error(`${where} needs a workspaceMemberId or at least one apiKeyNames entry`);
    return { code, label, authEmail, workspaceMemberId: wm, apiKeyNames: (keys as string[]).map((k) => k.trim()), mailboxes: (boxes as string[]).map((b) => b.trim().toLowerCase()) };
  });
}

/** The configured members; the sample member in sample mode when nothing is configured. */
export function teamMembers(env: Record<string, string | undefined> = process.env): TeamMember[] {
  const members = parseMembers(env.GTM_TEAM_MEMBERS);
  if (!members.length && contentMode(env) === "sample") return SAMPLE_MEMBERS;
  return members;
}

export const memberByCode = (members: TeamMember[], code: string | null | undefined) => members.find((m) => m.code === code) ?? null;
export const memberByEmail = (members: TeamMember[], email: string | null | undefined) =>
  email ? members.find((m) => m.authEmail === email.trim().toLowerCase()) ?? null : null;

/** True when a Twenty row's `createdBy` belongs to the member. */
export function isMemberRow(createdBy: CreatedBy, member: TeamMember): boolean {
  if (!createdBy) return false;
  if (member.workspaceMemberId && createdBy.workspaceMemberId === member.workspaceMemberId) return true;
  return createdBy.source === "API" && !!createdBy.name && member.apiKeyNames.includes(createdBy.name);
}

/** The Twenty GraphQL filter for rows the member created (one `or` per identity; `eq` is what Twenty filters on). */
export function createdByFilter(member: TeamMember): Record<string, unknown> {
  const or: Record<string, unknown>[] = member.apiKeyNames.map((name) => ({ createdBy: { name: { eq: name } } }));
  if (member.workspaceMemberId) or.push({ createdBy: { workspaceMemberId: { eq: member.workspaceMemberId } } });
  return or.length === 1 ? or[0] : { or };
}
