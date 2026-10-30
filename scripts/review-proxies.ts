// node --import tsx scripts/review-proxies.ts --story <id> [--apply]
// Defaults to a read-only plan. Existing proxies and masters over 50 MiB already covered by staging are left alone.
import { mkdtempSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { adminDb, must } from "../lib/db";
import { readPages } from "../lib/db-read";
import { BUCKET } from "../lib/review";
import { LARGE_MEDIA_BYTES, sha256File } from "../lib/large-media";
import { needsReviewProxy, stageReviewProxy } from "../lib/review-proxy";
import type { StoryAsset } from "../lib/story";

const args = process.argv.slice(2);
if (args.some((a) => a.startsWith("--") && !["--story", "--apply"].includes(a))) throw new Error("Use --story <id> [--apply]");
const at = args.indexOf("--story"), story = at >= 0 ? args[at + 1] : undefined;
if (!story || story.startsWith("--")) throw new Error("--story <id> is required");
const db = adminDb();
const assets = await readPages<StoryAsset>((from, to) => db.from("gtm_story_assets").select("*", { count: "exact" })
  .eq("story_id", story).eq("kind", "video").order("id").range(from, to), "proxy assets");
for (const a of assets) {
  const bytes = Number(a.metadata?.bytes);
  if (!a.storage_path || a.metadata?.proxy_path || !needsReviewProxy(bytes) || bytes > LARGE_MEDIA_BYTES) continue;
  console.log(`${args.includes("--apply") ? "Rendering" : "Would render"} ${a.id} (${bytes} bytes)`);
  if (!args.includes("--apply")) continue;
  const dir = mkdtempSync(join(tmpdir(), "gtm-proxy-backfill-"));
  try {
    const signed = must(await db.storage.from(BUCKET).createSignedUrl(a.storage_path, 600), "sign master");
    if (!signed) throw new Error(`${a.id}: could not sign master`);
    const abs = join(dir, "master.mp4");
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(240_000) });
        if (!r.ok || !r.body) throw new Error(`${a.id}: download HTTP ${r.status}`);
        await pipeline(Readable.fromWeb(r.body as any), createWriteStream(abs, { mode: 0o600 }));
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        console.log(`${a.id}: retrying interrupted master download`);
      }
    }
    if (sha256File(abs) !== a.sha256) throw new Error(`${a.id}: master does not match approved bytes`);
    const proxy = await stageReviewProxy(db, a.story_id, { id: a.id, abs, sha256: a.sha256, bytes });
    if (!proxy.proxy_path) { console.log(`${a.id}: master is already smaller than its review copy`); continue; }
    const saved = must(await db.from("gtm_story_assets").update({ metadata: { ...a.metadata, ...proxy } })
      .eq("id", a.id).eq("sha256", a.sha256).eq("metadata", JSON.stringify(a.metadata ?? {})).select("id"), "attach proxy");
    if (!saved?.length) throw new Error(`${a.id}: asset changed during rendering; proxy was not attached`);
    console.log(`${a.id}: ${proxy.proxy_bytes} review bytes; master and approvals preserved`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
