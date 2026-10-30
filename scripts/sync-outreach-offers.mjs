// Canonical catalog -> CRM profile. Check mode is read-only; --write updates only offer assets.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const catalog = JSON.parse(fs.readFileSync(new URL("../config/outreach-offers.json", import.meta.url), "utf8"));
const target = process.argv.find((arg) => arg.startsWith("--profile="))?.slice(10);
if (!target) throw new Error("Pass --profile=/absolute/path/to/outreach_profile.json [--write]");
const profile = JSON.parse(fs.readFileSync(target, "utf8"));
const ids = new Set(catalog.offers.map((offer) => offer.id));
const assets = catalog.offers.filter((offer) => offer.active).map((offer) => ({ id: offer.id, name: offer.name, url: offer.url, pitch: Object.values(offer.claims).join(" "), fits: offer.fits, scope: offer.scope, deliverables: offer.deliverables, inputs: offer.inputs, poor_fit: offer.poor_fit, prohibited: offer.prohibited, claims: offer.claims, ...(offer.not_to_be_confused_with ? { not_to_be_confused_with: offer.not_to_be_confused_with } : {}), category: "free-tool", catalog_version: catalog.version, catalog_source: "Pravos-LLC/vibrana-gtm/config/outreach-offers.json" }));
const other = profile.assets.filter((asset) => !ids.has(asset.id)).map((asset) => ({ ...asset, category: asset.id === "build-sprint" ? "paid-service" : "collaboration" }));
delete profile.offer_catalog;
const expected = { ...profile, assets: [...assets, ...other] };
if (process.argv.includes("--write")) fs.writeFileSync(target, JSON.stringify(expected, null, 2) + "\n");
else if (JSON.stringify(profile) !== JSON.stringify(expected)) { console.error("CRM offer definitions differ from the catalog. Run", fileURLToPath(import.meta.url), "with --write."); process.exitCode = 1; }
else console.log("CRM offer definitions match catalog version", catalog.version);

const snapshot = process.argv.find((arg) => arg.startsWith("--snapshot="))?.slice(11);
if (snapshot) {
  const expectedSnapshot = JSON.stringify(catalog, null, 2) + "\n";
  if (process.argv.includes("--write")) fs.writeFileSync(snapshot, expectedSnapshot);
  else if (fs.readFileSync(snapshot, "utf8") !== expectedSnapshot) { console.error("CRM catalog snapshot differs from source"); process.exitCode = 1; }
}
