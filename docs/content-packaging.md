# Content packaging

The packaging toolkit renders covers and thumbnails from a source-backed brief. A brand profile (from the runtime configuration) supplies identity, palette and supporting fonts; a registered template and optional style supply the composition; headline typography is chosen independently. Every render is tied to its sources by hash.

## Commands

```bash
gtm packaging catalog --json
gtm packaging brief <story-id> --brand <profile> [--theme light|dark] --json
# Complete the brief against the actual cut and set ready: true.
gtm packaging render <story-id> [--manifest story.yaml] [--brief path] [--asset-root path] --json
gtm packaging check <story-id> [--manifest story.yaml] --json
gtm packaging revise <story-id> --notes <feedback-id,...> --json
gtm packaging gallery <story-id> --out <directory> [--asset-root path] --json
gtm packaging motion <story-id> --brief <path> --out title.webm [--shape landscape|portrait|square|feed] [--asset-root path]
gtm packaging frame <story-id> --video <cut.mp4> --at <seconds> --out <directory>
```

`--manifest` disambiguates a Story; `--brief` selects a separate candidate or production brief. `brief` preserves an existing brief. Renders are content-addressed under `packaging/<story-id>/renders/<key>/`, and `latest.json` points at the newest one.

### Frame covers

When the owner wants the cover to be a screen from the cut itself (the opening title card, say), `frame` takes that exact frame instead of composing a template: no brand, font or brief is involved. It writes `<directory>/frame-<key>/<shape>.jpg` at the registered size for the video's shape, and a `manifest.json` (`kind: "frame"`) binding the cover to the video's sha256 and the timestamp. Point the Story's cover asset at both, as with any render (`source:` the JPEG, `packaging:` the manifest).

The staging gate accepts a frame cover only when its source video is one of the videos being staged. If the cut changes, the old frame fails with "re-extract it from the current cut" until `frame` runs again on the new file. A frame cover does not replace art direction: use it when the frame is the deliberate choice, not to skip a brief.

## Licensed fonts and marks

Brand and headline fonts (and the AIOS wordmark) are licensed assets. They are **not** in this repository, and nothing here copies them in. The renderer reads them from an asset root with this layout:

```
<asset-root>/
  fonts/<profile and headline font files>.woff2
  aios-wordmark-black.svg, aios-wordmark-white.svg   # only for the aios profile
```

Point the renderer at your copy with either:

| Input | Scope |
| --- | --- |
| `--asset-root <path>` | One `render`, `gallery` or `motion` run. Wins over the environment. |
| `PACKAGING_ASSET_ROOT=<path>` | Every packaging render in that shell, or in `.env.local`, which the CLI loads. |

With neither set, the renderer looks in the ignored `assets/packaging/` of this checkout, which is empty in a fresh clone. A supplied root fails closed, the same way the private overlay inputs do: it must be an absolute path to an existing directory **outside this checkout** (a symlink that resolves inside it is refused) and must contain `fonts/`. An invalid root is an error, never a quiet fallback to the bundled location.

A missing font or mark stops the render with `Missing licensed font <path>` or `Missing licensed mark <path>`. The toolkit never substitutes another typeface: a cover in the wrong brand font is worse than no cover.

The render manifest records every font and mark it used among its `inputs`, with a SHA256 of the bytes, alongside the brief, sources and renderer files. `gtm packaging check` rehashes them, so changed or missing font bytes mark the package stale. Paths are stored relative to the render directory, so check a package on the machine (and with the asset root) that rendered it.

Real brand profiles need private mode (see [private data loading](private-overlay.md)). The asset root is independent of the content mode: sample profiles reference licensed font files too, so a render needs it in either mode.

## Production handoff

Add each final cover to the Story manifest as an image with `role: cover` and `packaging: <path to the render manifest, relative to story.yaml>`. `gtm story stage` refuses a new or changed cover without a current, valid package. Run `gtm story stage ... --dry-run` first. Staging is preparation, never approval.
