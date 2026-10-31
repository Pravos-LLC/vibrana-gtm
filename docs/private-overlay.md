# Private data loading

Current operating contract: October 31, 2026. [Deployment context](deployment.md) records the live source, preview boundaries and workflow holds.

## Samples and local private mode

`CONTENT_MODE=sample` is the default. Guide inputs come from `content/sample`, and operational defaults come from `config/runtime.sample.json`. Tests and demos force samples, even if a private directory is linked locally. Sample mode never fetches private content. A hosted preview requesting private mode is refused.

Local private mode requires `CONTENT_MODE=private`, an absolute external `PRIVATE_OVERLAY_ROOT`, the overlay manifest revision/digest and a separate runtime configuration digest. The root contains nineteen declared JSON content files, `manifest.json` and `runtime.json`. The schema-1 manifest maps every required content path to its SHA256; `REQUIRED_CONTENT` in `lib/content-overlay.mjs` defines the exact set. `lib/runtime-config.mjs` separately validates the typed schema-1 operational configuration.

Missing, changed, malformed, incomplete or escaped inputs fail closed. Private mode has no automatic sample fallback. Private writers require a separate external `CONTENT_WRITE_ROOT` and cannot mutate an immutable snapshot. Review a new revision and digests after content changes. Public samples do not establish the operator's real guide, strategy, accounts or recipients.

## Operated production delivery

Production uses the protected HTTPS artifact path. Organization policy disables deploy keys; the optional SSH implementation is not the operated configuration, and does not justify changing that policy. A broad repository or private-hub read credential is unsuitable.

The dedicated data-only project's immutable HTTPS artifact requires authentication on every deployment. The protection-bypass credential is project-scoped and sent in `x-vercel-protection-bypass`, never a URL. Its effective read-only boundary depends on keeping that project static, without executable or write endpoints; it is not a provider-management token.

| Setting | Meaning |
| --- | --- |
| `PRIVATE_CONTENT_URL` | Approved immutable protected artifact URL |
| `PRIVATE_CONTENT_READ_TOKEN` | Project-scoped protection-bypass credential |
| `PRIVATE_CONTENT_REVISION` | Forty-hex private delivery Git revision |
| `PRIVATE_CONTENT_BUNDLE_DIGEST` | SHA256 of the actual served compressed artifact bytes |
| `PRIVATE_OVERLAY_REVISION` | Schema-1 content manifest revision, independently checked |
| `PRIVATE_OVERLAY_DIGEST` | SHA256 of the original `manifest.json` bytes |
| `PRIVATE_RUNTIME_DIGEST` | SHA256 of the original `runtime.json` bytes |

These settings are production-only protected configuration. Keep their actual private values and artifact addresses out of public documentation. Do not assume locally produced gzip bytes equal the served artifact: verify the downloaded compressed digest and every original member byte.

The gzip JSON envelope contains `schemaVersion: 1`, the exact delivery revision and a `files` map of the twenty-one allowed paths to base64 original bytes. The loader rejects redirects, unapproved hostnames/paths, URL queries or credentials, unexpected files, noncanonical base64, oversized responses/files and excessive gzip expansion. The content manifest and runtime configuration hashes remain independently required.

Operational configuration includes account/publication bindings, reviewed offer and candidate policy, analytics/packaging identities and mail/brand defaults. It is structured data, not executable source overrides. Clients receive only the selected authorized presentation fields; private registries and guide material stay server-side.

## Build and deployment binding

The production provider uses `node scripts/production-install.mjs`, then `node scripts/production-build.mjs`. The installer removes restored private build caches and runs a full frozen-lockfile install with lifecycle scripts disabled, an allowlisted environment and a temporary home directory. Environment scrubbing alone is not an operating-system sandbox.

The build checks the canonical provider project, GitHub repository identity, protected `main` branch, actual source SHA/deployment ID and private mode before fetching. It validates the data, materializes only approved bytes into ignored `.content-runtime`, removes fetching credentials before Next and cleans temporary delivery files on success or failure. Failed builds also remove generated private payloads. The server runtime traces the materialized files; sample builds remove private payloads and previous build caches.

An immutable server-only release stamp binds provider identity and source/deployment IDs to the private revision, content/runtime digests and artifact URL/compressed digest. Runtime requires the same bindings. The stamp is a deployment binding; protected-branch review and required CI establish source trust. Normal protected-main merges receive a new stamp automatically. `PRIVATE_RELEASE_SHA` is intentionally unset in the operated deployment; the optional implementation setting would impose an additional manual source constraint.

Keep private data, credentials, generated payloads and release stamps out of public Git, CI, forks, previews, client bundles and shared sample caches. The real production project has previews disabled; use the separate sample-preview project. Before any replacement is promoted, verify authentication denial, authorized artifact hashes, server file tracing and applicable application authorization/runtime behavior while the prior production deployment remains available for rollback.
