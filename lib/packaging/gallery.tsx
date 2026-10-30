import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { COVER_STYLES } from "./styles";
import { BRANDS, PROFILES, TEMPLATES } from "./catalog";
import { readBrief, checkPackage } from "./model";
import { renderPackage } from "./render";

export async function renderGallery(briefPath: string, output: string, options: { styles?: boolean; artDir?: string } = {}) {
  const original = readBrief(briefPath), root = resolve(output);
  mkdirSync(root, { recursive: true });
  const entries: Array<{ brand: string; theme: string; template: string; landscape: string; portrait: string; square: string; manifest: string }> = [];
  const styles = options.styles ? Object.keys(COVER_STYLES) as Array<keyof typeof COVER_STYLES> : undefined;
  const selections = styles ? styles.map(style => ({ template: COVER_STYLES[style].family, style })) : (Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>).map(template => ({ template, style: undefined }));
  const total = BRANDS.length * 2 * selections.length;
  const { style: _oldStyle, typography: _oldType, backdropText: _oldBackdrop, ...base } = original;
  for (const brand of BRANDS) for (const theme of ["light", "dark"] as const) for (const { template, style } of selections) {
    const dir = resolve(root, brand, theme, style ?? template); mkdirSync(dir, { recursive: true });
    // Relative source references must be rebased when a specimen moves.
    const rebase = (p: string) => relative(dir, resolve(dirname(briefPath), p));
    const b = { ...base, brand, theme, template, ...(style ? { style, ...(style === "make-statement" ? { backdropText: original.backdropText ?? original.emphasis ?? "VOICE" } : {}) } : {}), shapes: ["landscape", "portrait", "square"] as const,
      sources: [...original.sources.filter(s => s.role !== "video").map(s => ({ ...s, path: rebase(s.path) })), {path: rebase(briefPath), role: "decision" as const}, ...(options.artDir && style ? ["generation", "result"].map(suffix => resolve(options.artDir!, `${style}.${suffix}.json`)).filter(existsSync).map(path => ({ path: relative(dir,path), role: "decision" as const })) : [])],
      opening: { ...original.opening, source: rebase(original.opening.source) },
      payoff: { ...original.payoff, source: rebase(original.payoff.source) },
      portraits: original.portraits.map((p,i) => {
        const alternate = style === "share-story" ? `subject-${i+1}-ink.png` : ["as-recorded","collaborate-together"].includes(style ?? "") ? `subject-${i+1}-recorded.jpg` : undefined;
        const source = alternate && options.artDir ? resolve(options.artDir,alternate) : undefined;
        return {...p,path:source && existsSync(source) ? relative(dir,source) : rebase(p.path)};
      }),
      ...(options.artDir && style ? { background: relative(dir, resolve(options.artDir, `${style}.png`)), backgroundTreatment: theme === "light" && !["editorial-take","share-story"].includes(style) ? "atmosphere" as const : "photographic" as const } : original.background ? { background: rebase(original.background) } : {}),
      ...(original.focal ? { focal: rebase(original.focal) } : {}),
      selection: "Layout specimen only. Production selection must match the actual content and payoff.",
    };
    const path = resolve(dir, "brief.json"); writeFileSync(path, JSON.stringify(b, null, 2) + "\n");
    const r = await renderPackage(path); const errors = checkPackage(r.manifest);
    if (errors.length) throw new Error(errors.join("; "));
    const m = JSON.parse(readFileSync(r.manifest, "utf8"));
    const image = (shape: string) => relative(root, resolve(dirname(r.manifest), m.assets.find((a: { path: string }) => a.path === shape + ".jpg").path));
    entries.push({ brand, theme, template: style ?? template, landscape: image("landscape"), portrait: image("portrait"), square:image("square"), manifest: relative(root, r.manifest) });
    process.stderr.write(`packaging gallery: ${entries.length}/${total}\n`);
  }
  const cards = entries.map(e => <article key={e.manifest} data-brand={e.brand} data-theme={e.theme}>
    <a href={e.landscape} className="landscape"><img src={e.landscape} alt={(COVER_STYLES[e.template as keyof typeof COVER_STYLES]?.name ?? TEMPLATES[e.template as keyof typeof TEMPLATES].name)} loading="lazy"/></a>
    <a href={e.portrait} className="portrait"><img src={e.portrait} alt={(COVER_STYLES[e.template as keyof typeof COVER_STYLES]?.name ?? TEMPLATES[e.template as keyof typeof TEMPLATES].name) + " vertical"} loading="lazy"/></a>
    <a href={e.square} className="square-cover"><img src={e.square} alt="Square artwork" loading="lazy"/></a>
    <div className="caption"><h2>{(COVER_STYLES[e.template as keyof typeof COVER_STYLES]?.name ?? TEMPLATES[e.template as keyof typeof TEMPLATES].name)}</h2><details><summary>Details</summary><p>{(COVER_STYLES[e.template as keyof typeof COVER_STYLES]?.composition ?? TEMPLATES[e.template as keyof typeof TEMPLATES].role)}</p><a href={e.manifest}>Production manifest</a></details> {styles && <a data-motion href={e.landscape.replace("landscape.jpg", "landscape-motion.html")}>Play / scrub motion</a>}</div>
  </article>);
  const html = renderToStaticMarkup(<html><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Content Packaging / Template Library</title></head><body>
    <header><p className="eyebrow">CONTENT PACKAGING / 01</p><h1>Thumbnail studies</h1><p>{styles ? "Twelve Riverside-inspired styles. Three identities. Two themes. Headline type is independent of website fonts. Click motion to play or scrub native layers." : "Seven compositions. Three identities. Two themes. Each specimen uses the same real episode source."}</p><nav>
      <label>Brand <select id="brand">{BRANDS.map(b => <option value={b} key={b}>{PROFILES[b].name}</option>)}</select></label>
      <label>Theme <select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label>Shape <select id="shape"><option value="landscape">Episode / horizontal</option><option value="portrait">Short / vertical</option><option value="square">Spotify / square</option></select></label>
    </nav></header><main>{cards}</main><footer>Composition specimens, not performance claims. Click an image for its full export. Refer to the playbook for selection and evidence.</footer>
  </body></html>);
  const css = `body{margin:0;background:#f2efe9;color:#191916;font-family:system-ui,sans-serif}body>header{padding:28px 6vw 18px;max-width:1200px}.eyebrow{font-size:12px;letter-spacing:.16em}h1{font-size:clamp(28px,4vw,40px);line-height:1.05;letter-spacing:-.05em;margin:14px 0}header>p{max-width:620px;line-height:1.6}nav{display:flex;gap:24px;flex-wrap:wrap;margin-top:32px}label{display:flex;gap:8px;align-items:center;font-size:13px}select{padding:10px;border:1px solid #b8b4ad;background:transparent;border-radius:4px;font:inherit}main{padding:24px 6vw;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:40px}article{border-bottom:1px solid #c9c4bb;padding-bottom:22px}article[hidden]{display:none}article img{width:100%;display:block}.portrait,.square-cover{display:none}body.square .square-cover{display:block}body.square .landscape{display:none}body.vertical main{grid-template-columns:repeat(3,minmax(0,1fr))}body.vertical .portrait{display:block}body.vertical .landscape{display:none}.caption h2{font-size:18px;margin:18px 0 6px}.caption p{font-size:13px;margin:6px 0 16px;line-height:1.5}.caption a{font-size:11px;color:inherit}footer{padding:30px 6vw 60px;font-size:12px;line-height:1.6}@media(max-width:720px){main,body.vertical main{grid-template-columns:1fr}body>header{padding-top:40px}} `;
  const js = `function update(){const shape=document.querySelector('#shape').value;document.querySelectorAll('[data-motion]').forEach(a=>a.setAttribute('href',a.getAttribute('href').replace(/(landscape|portrait|square)-motion[.]html$/,shape+'-motion.html')));document.querySelectorAll('article').forEach(a=>a.hidden=a.dataset.brand!==document.querySelector('#brand').value||a.dataset.theme!==document.querySelector('#theme').value);document.body.classList.toggle('vertical',document.querySelector('#shape').value==='portrait');document.body.classList.toggle('square',document.querySelector('#shape').value==='square')}document.querySelectorAll('select').forEach(s=>s.addEventListener('change',update));update();`;
  writeFileSync(resolve(root, "index.html"), "<!doctype html>" + html.replace("</head>", `<style>${css}</style></head>`).replace("</body>", `<script>${js}</script></body>`));
  writeFileSync(resolve(root, "index.json"), JSON.stringify(entries, null, 2) + "\n");
  return { gallery: resolve(root, "index.html"), combinations: entries.length };
}
