import { demoMode } from "./demo";
// Read-only Wise client (local CLI only: statements need SCA signing with the private key).
// Mirrors john-workspace/.tools/wise-mcp, which holds the credentials in its .env.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API = "https://api.wise.com";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see john-workspace/.tools/wise-mcp/.env)`);
  return v;
}

async function get(path: string, query: Record<string, string> = {}): Promise<any> {
  if (demoMode()) throw new Error("Demo mode: unsupported financial provider read");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `Bearer ${env("WISE_API_TOKEN")}` };
  let res = await fetch(url, { headers });
  const challenge = res.status === 403 ? res.headers.get("x-2fa-approval") : null;
  if (challenge) {
    const key = readFileSync(process.env.WISE_PRIVATE_KEY_PATH ?? `${homedir()}/.wise/private.pem`, "utf8");
    const signature = createSign("SHA256").update(challenge).sign(key, "base64");
    res = await fetch(url, { headers: { ...headers, "x-2fa-approval": challenge, "X-Signature": signature } });
  }
  if (!res.ok) throw new Error(`Wise ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export type WiseTxn = {
  id: string; // referenceNumber, e.g. CARD-123
  date: string;
  currency: string;
  amount: number; // negative = money out
  description: string;
  merchant: string | null;
  merchantCategory: string | null;
  type: string;
};

export async function statement(fromDate: string, toDate: string): Promise<WiseTxn[]> {
  if (demoMode()) return [{ id: "sample-transaction", date: `${fromDate}T12:00:00Z`, currency: "USD", amount: -12, description: "Sample software", merchant: "Sample vendor", merchantCategory: "software", type: "CARD" }];
  const profile = env("WISE_PROFILE_ID");
  const balances: any[] = await get(`/v4/profiles/${profile}/balances`, { types: "STANDARD" });
  const out: WiseTxn[] = [];
  for (const b of balances) {
    const currency = b.amount?.currency ?? b.currency;
    const data = await get(`/v1/profiles/${profile}/balance-statements/${b.id}/statement.json`, {
      currency, intervalStart: `${fromDate}T00:00:00.000Z`, intervalEnd: `${toDate}T23:59:59.999Z`, type: "COMPACT",
    });
    for (const t of data.transactions ?? []) {
      out.push({
        id: t.referenceNumber,
        date: String(t.date).slice(0, 10),
        currency,
        amount: t.amount?.value ?? 0,
        description: t.details?.description ?? "",
        merchant: t.details?.merchant?.name ?? null,
        merchantCategory: t.details?.merchant?.category ?? null,
        type: t.details?.type ?? t.type,
      });
    }
  }
  return out;
}
