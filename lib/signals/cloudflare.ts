import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Workers AI calls for the Signal Desk: Clef-flash decisions and bge-m3 embeddings.
// On Vercel: REST with CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (a token scoped to Workers AI).
// On the Mac without a token: the logged-in `cf` CLI (`cf ai run`), so local runs need no extra secret.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const CLEF_MODEL = "@cf/cloudflare/clef-flash";
export const EMBED_MODEL = "@cf/baai/bge-m3";

export type ClefQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> };
export type ClefResponse = { model: string; answers: Record<string, ClefAnswer>; usage?: { input_tokens: number } };

export type AiRunner = (model: string, body: unknown) => Promise<unknown>;

function restRunner(accountId: string, token: string, fetcher: typeof fetch): AiRunner {
  return async (model, body) => {
    assertLiveProvidersAllowed();
    const res = await providerFetch(fetcher)(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { message: string }[] } | null;
    if (!res.ok || !data || data.success === false) throw new Error(`workers ai ${model}: ${res.status} ${data?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
    return data.result ?? data;
  };
}

function cliRunner(): AiRunner {
  const run = promisify(execFile);
  return async (model, body) => {
    assertLiveProvidersAllowed();
    const dir = mkdtempSync(join(tmpdir(), "signals-ai-"));
    try {
      const file = join(dir, "body.json");
      writeFileSync(file, JSON.stringify(body));
      const { stdout } = await run("cf", ["ai", "run", model, "--body", `@${file}`], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
      return JSON.parse(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** REST when a token is configured, otherwise the local cf CLI. */
export function aiRunner(fetcher: typeof fetch = fetch): AiRunner {
  assertLiveProvidersAllowed();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (accountId && token) return restRunner(accountId, token, fetcher);
  if (process.env.VERCEL) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required on Vercel");
  return cliRunner();
}

export async function clef(run: AiRunner, state: string, questions: Record<string, ClefQuestion>): Promise<ClefResponse> {
  return await run(CLEF_MODEL, { model: "clef-flash", state, questions }) as ClefResponse;
}

/** bge-m3 embeddings (1024 dims), batched. */
export async function embed(run: AiRunner, texts: string[], batch = 50): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const res = await run(EMBED_MODEL, { text: texts.slice(i, i + batch) }) as { data: number[][] };
    if (!Array.isArray(res.data) || res.data.length !== Math.min(batch, texts.length - i)) throw new Error("embedding count mismatch");
    out.push(...res.data);
  }
  return out;
}
