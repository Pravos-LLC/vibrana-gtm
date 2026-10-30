import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { hash } from "./model";
import { guardMediaBytes } from "../media-guard";
/** One explicit paid generation; never resubmit a job after a poll failure. */
export async function generatePlate(prompt: string, reference: string | undefined, output: string) {
  const out = resolve(output); mkdirSync(dirname(out), { recursive: true });
  const lock = out + ".generation.lock";
  try { closeSync(openSync(lock, "wx")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Plate request already running. If interrupted, verify the recorded job before removing its lock; never resubmit blindly."); throw e; }
  try { return await generatePlateLocked(prompt, reference, out); }
  finally { unlinkSync(lock); }
}
async function generatePlateLocked(prompt: string, reference: string | undefined, output: string) {
  if (!prompt.trim()) throw new Error("plate generation needs a prompt");
  assertLiveProvidersAllowed();
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is missing; source-only rendering still works");
  const endpoint = reference ? "fal-ai/nano-banana-pro/edit" : "fal-ai/nano-banana-pro";
  const input = { prompt, num_images: 1, aspect_ratio: "16:9", resolution: "2K", output_format: "png",
    ...(reference ? { image_urls: [`data:${extname(reference).toLowerCase() === ".png" ? "image/png" : "image/jpeg"};base64,${readFileSync(reference).toString("base64")}`] } : {}) };
  const out = resolve(output); mkdirSync(dirname(out), { recursive: true });
  const fingerprint = hash(JSON.stringify(input)), sidecar = out + ".generation.json";
  let job: { request_id: string; status_url: string; response_url: string };
  if (existsSync(sidecar)) {
    const previous = JSON.parse(readFileSync(sidecar, "utf8"));
    if (previous.fingerprint !== fingerprint) throw new Error("This plate path belongs to a different request. Use a new output filename.");
    if (previous.status === "completed" && existsSync(out) && previous.sha256 === hash(readFileSync(out))) return { path: out, requestId: previous.requestId, costUsd: null, cached: true };
    if (previous.status === "completed") throw new Error("Completed plate bytes changed. Restore them or use a new output filename; do not rebill.");
    if (!previous.job) throw new Error("Previous submission has no confirmed job id. Check the fal dashboard before a new explicit request; no automatic resubmission.");
    job = previous.job;
  } else {
    // Persist intent before the network call: an ambiguous timeout may already have been billed.
    writeFileSync(sidecar, JSON.stringify({ fingerprint, provider: "fal.ai", model: endpoint, status: "submitting", promptHash: hash(prompt), costUsd: null }) + "\n");
    const response = await providerFetch()(`https://queue.fal.run/${endpoint}`, { method: "POST", headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`fal submission failed (${response.status}); no automatic resubmission`);
    job = await response.json() as typeof job;
  }
  const record = { provider: "fal.ai", model: endpoint, requestId: job.request_id, job, fingerprint, promptHash: hash(prompt), referenceHash: reference ? hash(readFileSync(reference)) : null, costUsd: null, costStatus: "provider-billed; retrieve actual charge from fal dashboard", status: "submitted" };
  writeFileSync(out + ".generation.json", JSON.stringify(record, null, 2) + "\n");
  // Provider-returned URLs must remain on its queue domain before sending credentials.
  for (const url of [job.status_url, job.response_url]) if (new URL(url).origin !== "https://queue.fal.run") throw new Error("Unexpected fal queue URL");
  for (let poll = 0; poll < 120; poll++) {
    const status = await providerFetch()(job.status_url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30000) });
    if (!status.ok) throw new Error(`fal polling failed (${status.status}); retain request ${job.request_id}, do not resubmit`);
    const s = await status.json() as { status: string };
    if (s.status === "COMPLETED") {
      const r = await providerFetch()(job.response_url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`fal result failed (${r.status})`);
      const data = await r.json() as { images: Array<{ url: string }> };
      if (!data.images?.[0]?.url?.startsWith("https://")) throw new Error("fal returned no image");
      const image = await providerFetch()(data.images[0].url, { signal: AbortSignal.timeout(30000) });
      if (!image.ok) throw new Error(`fal image download failed (${image.status})`);
      const bytes = Buffer.from(await image.arrayBuffer());
      guardMediaBytes(bytes, "image/png", out, { publish: false });
      writeFileSync(out, bytes);
      writeFileSync(out + ".generation.json", JSON.stringify({ ...record, status: "completed", sha256: hash(bytes) }, null, 2) + "\n");
      return { path: out, requestId: job.request_id, costUsd: null };
    }
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(s.status)) throw new Error(`fal job ended with ${s.status}; no resubmission`);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`fal request ${job.request_id} is still pending; resume that job instead of resubmitting`);
}
