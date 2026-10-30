import { describe, it } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { withoutEmsignRoots } from "../lib/security/emudhra-trust-guard";

const subject = (pem: string) => new X509Certificate(pem).subject;
const t = tls as typeof tls & { getCACertificates?: (type?: string) => string[] };

describe("eMudhra trust guard", () => {
  it("drops every emSign root and nothing else", { skip: !t.getCACertificates }, () => {
    const roots = t.getCACertificates!("bundled");
    const emsign = roots.filter((pem) => subject(pem).includes("CN=emSign"));
    const kept = withoutEmsignRoots(roots);
    assert.ok(kept.every((pem) => !subject(pem).includes("emSign")));
    assert.ok(kept.length === roots.length - emsign.length);
    assert.ok(kept.some((pem) => subject(pem).includes("ISRG Root X1")));
  });
});
