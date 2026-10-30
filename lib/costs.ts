import { providerFetch } from "./demo-safety";
// Classify Wise card charges against config/vendors.yaml and push them to gtm_spend.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { WiseTxn } from "./wise";
import { adminDb, must } from "./db";

type Vendor = { vendor: string; match: string; category: string; gtm: boolean };
type Registry = { vendors: Vendor[]; software_categories: string[] };

export function loadRegistry(path = fileURLToPath(new URL("../config/vendors.yaml", import.meta.url))): Registry {
  return parse(readFileSync(path, "utf8"));
}

export function classify(reg: Registry, merchant: string, merchantCategory: string | null) {
  // Only software-like merchant categories are considered (unknown category is allowed), so a
  // restaurant or hotel whose name happens to contain a vendor word is never booked as a tool.
  const software = merchantCategory == null || reg.software_categories.some((c) => merchantCategory.includes(c));
  if (!software) return null;
  for (const v of reg.vendors) if (new RegExp(v.match, "i").test(merchant)) return { vendor: v.vendor, category: v.category, gtm: v.gtm };
  // Only surface an unknown merchant when Wise actually says it's software.
  return merchantCategory == null ? null : { vendor: null, category: "unclassified", gtm: false };
}

/** EUR per unit of each currency, from Wise's public rates endpoint (current rate: approximate for past charges). */
async function eurRates(currencies: string[]): Promise<Record<string, number>> {
  const rates: Record<string, number> = { EUR: 1 };
  for (const c of currencies) {
    if (c === "EUR") continue;
    const res = await providerFetch()(`https://api.wise.com/v1/rates?source=${c}&target=EUR`, {
      headers: { Authorization: `Bearer ${process.env.WISE_API_TOKEN}` },
    });
    const j = await res.json();
    if (Array.isArray(j) && j[0]?.rate) rates[c] = j[0].rate;
  }
  return rates;
}

export async function spendRows(txns: WiseTxn[], reg = loadRegistry()) {
  const card = txns.filter((t) => t.type === "CARD" && t.amount < 0);
  const rates = await eurRates([...new Set(card.map((t) => t.currency))]);
  const rows = [];
  for (const t of card) {
    const merchant = t.merchant ?? t.description;
    const c = classify(reg, merchant, t.merchantCategory);
    if (!c) continue; // not a software/subscription charge
    const amount = -t.amount;
    rows.push({
      id: `${t.id}:${t.currency}`, date: t.date, currency: t.currency, amount, // one card charge can draw on two balances
      amount_eur: rates[t.currency] ? Math.round(amount * rates[t.currency] * 100) / 100 : null,
      merchant, ...c,
    });
  }
  return rows;
}

export async function pushSpend(rows: Awaited<ReturnType<typeof spendRows>>) {
  must(await adminDb().from("gtm_spend").upsert(rows), "upsert gtm_spend");
  return { rows: rows.length, unclassified: rows.filter((r) => !r.vendor).length };
}
