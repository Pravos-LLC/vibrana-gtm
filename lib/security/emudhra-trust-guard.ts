// eMudhra trust guard (2026-10-20).
//
// Eight eMudhra intermediates shipped with private keys recoverable from their public certificates,
// so anyone can mint a certificate that chains to the `emSign Root … G3` roots for ANY host. Node
// verifies TLS against its own compiled-in root store; the fix is Node 22.23.4 / 24.22.1 / 26.12.1,
// but Vercel's Node functions still ran 22.23.2 / 24.21.0 on 2026-10-22 and trusted a forged chain.
// Until they ship the fix, drop the emSign roots from the process-wide default CA set at startup:
// every later fetch / https / supabase-js / stripe call then refuses those chains. Probed on Vercel:
// the forged hosts are refused, Stripe, Resend, OpenRouter and Supabase still connect.
//
// Self-disabling: on a Node that already carries the fix this is a no-op. DELETE this file (and its
// call sites) once the deployed runtime reports a patched version.
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

const PATCHED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
let applied = false;

// Every emSign root (eMudhra) — a superset of upstream, whose patched Node drops G3/C1/C3 and keeps G1.
// A legitimate emSign-only site failing is the accepted cost; the Sectigo cross-sign path (AAA
// Certificate Services) is already absent from Node's store and from Vercel's.
export function withoutEmsignRoots(roots: string[]): string[] {
  return roots.filter((pem) => !/\bCN=emSign\b/.test(new X509Certificate(pem).subject.replace(/\n/g, ",")));
}

export function applyEmudhraTrustGuard(): void {
  if (applied) return;
  applied = true;
  try {
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const floor = PATCHED[major];
    if (floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]))) return;
    const t = tls as typeof tls & {
      getCACertificates?: (type?: string) => string[];
      setDefaultCACertificates?: (certs: string[]) => void;
    };
    if (!t.getCACertificates || !t.setDefaultCACertificates) {
      console.warn(`[emudhra-trust-guard] node ${process.version} cannot reset its CA store; upgrade Node`);
      return;
    }
    const roots = t.getCACertificates("default");
    const kept = withoutEmsignRoots(roots);
    if (kept.length !== roots.length) t.setDefaultCACertificates(kept);
  } catch (err) {
    // Never take the server down over this: log and keep the runtime's default store.
    console.error("[emudhra-trust-guard] failed; CA store unchanged:", err);
  }
}
