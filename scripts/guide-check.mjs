import { validateOverlay } from "../lib/content-overlay.mjs";
// Verifies the Content Guide against its sources, so the guide never silently forks them.
//
//   node scripts/guide-check.mjs [--strict]
//
// 1. Every { text, source } quote in content/guide/*.json must still appear verbatim (whitespace and
//    markdown emphasis normalised) in its source file under ~/Projects (GUIDE_SOURCES_ROOT).
//    Sources that aren't checked out (CI, Vercel) are skipped, unless --strict.
// 2. Every media key referenced anywhere must exist in content/guide/media.json.
// 3. No em or en dash anywhere in the guide, quotes included (John's rule for anything shown).
// 4. Vendored files (VENDORED below) are byte-identical to their hub source. The hub owns them; a change is
//    made there and copied here. Skipped when the hub is not checked out (CI, Vercel), unless --strict.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(validateOverlay().root, "guide");
if (validateOverlay().mode === "sample") {
  // Synthetic examples have no private sources or media to verify. Validate their JSON without
  // inspecting the local hub, even when it happens to be present on this machine.
  for (const file of readdirSync(DIR).filter(f => f.endsWith(".json"))) JSON.parse(readFileSync(join(DIR, file), "utf8"));
  console.log("guide-check: synthetic sample JSON validated; private provenance checks require private mode");
  process.exit(0);
}
const ROOT = process.env.GUIDE_SOURCES_ROOT ?? join(homedir(), "Projects");
const strict = process.argv.includes("--strict");
const media = JSON.parse(readFileSync(join(DIR, "media.json"), "utf8"));
const norm = (s) => s.replace(/[*_`>]/g, "").replace(/\\(.)/g, "$1").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

// File in content/guide -> its source, relative to GUIDE_SOURCES_ROOT. Edit the source, then copy it here.
const VENDORED = {
  "playbook-taxonomy.json": "vibrana/.agents/skills/content-canon/references/taxonomy.json",
};

const problems = [];
let checked = 0, skipped = 0, vendoredChecked = 0, vendoredSkipped = 0;
for (const [file, source] of Object.entries(VENDORED)) {
  const src = join(ROOT, source);
  if (!existsSync(src)) { vendoredSkipped++; if (strict) problems.push(`${file}: hub source missing ${source}`); continue; }
  vendoredChecked++;
  if (readFileSync(src, "utf8") !== readFileSync(join(DIR, file), "utf8")) problems.push(`${file}: differs from the hub's ${source}; copy it again (cp ${src} content/guide/${file})`);
}
const cache = new Map();
const read = (p) => (cache.has(p) ? cache.get(p) : (cache.set(p, existsSync(p) ? norm(readFileSync(p, "utf8")) : null), cache.get(p)));

function walk(node, where) {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
  if (!node || typeof node !== "object") {
    if (typeof node === "string" && /[–—]/.test(node)) problems.push(`${where}: em or en dash in guide text`);
    return;
  }
  const isQuote = typeof node.text === "string" && typeof node.source === "string" && Object.keys(node).length === 2;
  if (isQuote) {
    if (/[–—]/.test(node.text)) problems.push(`${where}: quote contains an em or en dash; the guide shows none, pick another line`);
    const body = read(join(ROOT, node.source));
    if (body === null) { skipped++; if (strict) problems.push(`${where}: source missing ${node.source}`); return; }
    checked++;
    if (!body.includes(norm(node.text))) problems.push(`${where}: not found verbatim in ${node.source}: "${node.text.slice(0, 70)}"`);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k === "media" || k === "hero_media") && typeof v === "string" && !media[v]) problems.push(`${where}.${k}: unknown media key ${v}`);
    if (k === "media" && Array.isArray(v)) v.forEach((m) => { if (typeof m === "string" && !media[m]) problems.push(`${where}.media: unknown media key ${m}`); });
    if (k === "images" && Array.isArray(v)) v.forEach((m) => { if (!media[m]) problems.push(`${where}.images: unknown media key ${m}`); });
    walk(v, `${where}.${k}`);
  }
}

for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "media.json")) walk(JSON.parse(readFileSync(join(DIR, f), "utf8")), f);

// If the sources are checked out at all, the check must actually have verified something; a root that
// resolves nothing is a misconfiguration, not a pass. On CI and Vercel nothing is checked out: say so.
if (existsSync(join(ROOT, "vibrana/gtm/content/STRATEGY.md")) && checked === 0) problems.push(`no quotes verified under ${ROOT}`);
if (checked === 0 && skipped > 0) console.warn(`guide-check: WARNING, ${skipped} quotes NOT verified (sources not checked out under ${ROOT}); run it locally after editing a source`);

if (problems.length) {
  console.error(`guide-check: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
if (vendoredSkipped && !vendoredChecked) console.warn(`guide-check: WARNING, ${vendoredSkipped} vendored files NOT compared with the hub (not checked out under ${ROOT})`);
console.log(`guide-check: ok (${checked} quotes verified, ${skipped} skipped: source not checked out; ${vendoredChecked} vendored files match the hub, ${vendoredSkipped} skipped)`);
