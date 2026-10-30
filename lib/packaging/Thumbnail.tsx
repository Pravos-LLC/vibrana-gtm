import { HEADLINE_TYPES, headlineType } from "./styles";
import React from "react";
import { PROFILES, SIZES, type Shape } from "./catalog";
import type { PackagingBrief } from "./model";

export function Portrait({ src, name, position }: { src: string; name: string; position?: string }) {
  return <div className="portrait" data-layer="subject"><img src={src} alt={name} style={{ objectPosition: position ?? "center bottom" }} /></div>;
}
/** One composition, with brand and semantic theme injected at the boundary. */
export function Thumbnail({ brief: b, shape, portraits, background, focal, logo }: {
  brief: PackagingBrief; shape: Shape; portraits: string[]; background?: string; focal?: string; logo?: string;
}) {
  const headline = HEADLINE_TYPES[headlineType(b)];
  const p = PROFILES[b.brand], t = p.themes[b.theme], [width, height] = SIZES[shape];
  const copy = b.coverText?.[shape], thumbnail = copy?.text ?? b.thumbnail, chosenEmphasis = copy?.emphasis ?? b.emphasis;
  const emphasis = chosenEmphasis && thumbnail.includes(chosenEmphasis) ? chosenEmphasis : undefined;
  const parts = emphasis ? thumbnail.split(emphasis) : [thumbnail];
  return <main className={`canvas ${b.template} ${shape} ${b.theme} ${b.style ? "style-" + b.style : ""} ${b.backgroundTreatment === "photographic" ? "photographic" : ""}`} style={{
    width, height, background: t.bg, color: t.fg,
    "--accent": t.accent, "--positive": t.positive, "--muted": t.muted,
    "--surface": t.bg, "--display": `"${headline.family}"`, "--body": `"${p.body}"`, "--identity": `"${p.display}"`,
    "--type-weight": headline.weight, "--type-transform": headline.transform, "--type-tracking": headline.tracking,
  } as React.CSSProperties}>
    {background && <div className="scene" data-layer="background"><img src={background} alt="" /></div>}
    <div className="atmosphere" data-layer="atmosphere" />
    <header data-layer="identity">{logo ? <img className="logo" src={logo} alt={p.name}/> : <span className="identity">{p.name}</span>}<span className="series">{b.eyebrow ?? "A conversation worth having"}</span></header>
    {b.style === "make-statement" && <div className="backdrop-type" data-layer="backdrop" aria-hidden="true">{b.backdropText ?? b.emphasis ?? b.thumbnail}</div>}
    <div className="subjects">{portraits.map((src, i) => <Portrait key={i} src={src} name={b.portraits[i].name} position={b.portraits[i].position}/>)}</div>
    {focal && <img className="focal-art" data-layer="focal" src={focal} alt="Source-backed visual for the cover promise"/>}
    <section className="headline-wrap" data-layer="headline"><h1>{parts.map((part, i) => <React.Fragment key={i}>{part}{i < parts.length - 1 && <mark>{emphasis}</mark>}</React.Fragment>)}</h1></section>
    <footer data-layer="names">{b.portraits.map(p => p.name).join("  /  ") || b.audience}</footer>
    <div className="signature" data-layer="accent"/>
  </main>;
}

export const thumbnailCss = `
.canvas.photographic .scene img{opacity:1}.photographic .atmosphere{background:linear-gradient(0deg,var(--surface),transparent 36%),linear-gradient(180deg,color-mix(in srgb,var(--surface) 55%,transparent),transparent 35%)}.photographic h1{text-shadow:0 2px 20px var(--surface)}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{overflow:hidden}.canvas{position:relative;overflow:hidden;isolation:isolate;font-family:var(--body);--headline:108px}
.canvas header{position:absolute;inset:5.4% 6% auto;display:flex;align-items:center;justify-content:space-between;gap:28px;z-index:5;font-size:22px}
.identity{font-family:var(--identity);font-weight:700;letter-spacing:-.02em}.series{color:var(--muted);font-size:18px}.logo{height:36px;width:auto;max-width:260px}
.atmosphere{position:absolute;inset:0;background:radial-gradient(ellipse at 80% 55%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 58%);z-index:-1}
.scene{position:absolute;inset:0;z-index:-2}.scene img{width:100%;height:100%;object-fit:cover;opacity:.25}.light .scene img{opacity:.15}
.subjects{position:absolute;display:flex;gap:2%;inset:20% 0 0 46%;height:80%}
.portrait{flex:1;min-width:0;height:100%;overflow:hidden;mask-image:linear-gradient(to bottom,#000 78%,transparent 100%)}
.portrait img{height:100%;width:100%;object-fit:contain;object-position:center bottom}.headline-wrap{position:absolute;inset:22% 51% 21% 6%;z-index:3;display:flex;align-items:center}
h1{margin:0;font-family:var(--display),sans-serif;font-size:var(--headline);font-weight:var(--type-weight);text-transform:var(--type-transform);line-height:1.02;letter-spacing:var(--type-tracking);overflow-wrap:normal;text-wrap:balance}
mark{background:none;color:var(--accent)}footer{position:absolute;bottom:7%;left:6%;color:var(--muted);font-size:20px;z-index:4}.signature{position:absolute;bottom:0;height:8px;width:100%;background:var(--accent)}
.focal-art{position:absolute;object-fit:contain;width:31%;right:8%;top:19%;fill:none;stroke:var(--accent);stroke-width:6;stroke-linecap:round;stroke-linejoin:round;z-index:2}
.clear-conversation .subjects{inset:16% 3% 0;height:84%;justify-content:space-between;gap:24%}.clear-conversation .portrait{mask-image:linear-gradient(to bottom,#000 80%,transparent)}.clear-conversation .headline-wrap{inset:23% 29% 20%;text-align:center;--headline:100px}
.bold-statement .headline-wrap{inset:17% 39% 18% 6%;--headline:138px}.bold-statement .subjects{inset:23% -4% 0 59%;height:77%}.bold-statement .portrait:nth-child(2){display:none}
.productive-tension .subjects{inset:21% 0 0;gap:21%}.productive-tension .headline-wrap{inset:66% 7% 11%;text-align:center;padding:0}.productive-tension .focal-art{top:12%;right:35%;width:30%}
.editorial-question .subjects{inset:14% 57% 0 0;height:86%}.editorial-question .portrait:nth-child(2){display:none}.editorial-question .headline-wrap{inset:21% 7% 18% 48%;--headline:112px}.editorial-question footer{left:48%}
.story-moment .subjects{inset:25% 0 0 58%;height:75%}.story-moment .headline-wrap{inset:25% 43% 24% 6%;--headline:110px}.story-moment .focal-art{top:65%;right:58%;width:25%;opacity:.55}
.explain-mechanism .subjects{inset:27% 0 0 65%;height:73%}.explain-mechanism .portrait:nth-child(2){display:none}.explain-mechanism .headline-wrap{inset:18% 43% 40% 6%;--headline:105px}.explain-mechanism .focal-art{top:57%;right:42%;width:48%}
.regenerative-possibility .subjects{inset:21% 0 0 60%;height:79%}.regenerative-possibility .headline-wrap{inset:20% 44% 37% 6%;--headline:112px}.regenerative-possibility .focal-art{top:57%;right:45%;width:42%;stroke:var(--positive)}
.portrait.canvas{display:block;mask-image:none;height:1920px}.canvas.portrait header{inset:4% 6% auto;display:block;font-size:27px}.canvas.portrait .series{display:block;margin-top:14px;font-size:22px}
.canvas.portrait .subjects{inset:25% 0 0;height:33%;gap:2%}.canvas.portrait .headline-wrap{inset:60% 7% 23%;text-align:left;padding:0;--headline:116px}.canvas.portrait footer{left:7%;bottom:6%;font-size:23px}
.canvas.portrait .focal-art{top:14%;right:7%;width:32%;opacity:.8}.canvas.portrait.bold-statement .subjects{inset:44% 0 0 20%;height:50%}.canvas.portrait.bold-statement .headline-wrap{inset:23% 7% 55%;--headline:143px}
.canvas.portrait.productive-tension .headline-wrap{inset:61% 7% 23%;padding:24px;--headline:110px}.canvas.portrait.productive-tension .subjects{top:24%;height:39%;gap:4%}.canvas.portrait.productive-tension .focal-art{top:12%;right:20%;width:60%}
.canvas.portrait.editorial-question .subjects{inset:47% 0 0 12%;height:46%}.canvas.portrait.editorial-question .headline-wrap{inset:23% 7% 55%;--headline:125px}
.canvas.portrait.story-moment .subjects{inset:41% 0 0;height:43%}.canvas.portrait.story-moment .headline-wrap{inset:23% 7% 60%;--headline:120px}.canvas.portrait.story-moment .focal-art{top:70%;right:8%;width:33%;opacity:.25}
.canvas.portrait.explain-mechanism .subjects{inset:57% 35% 0 0;height:36%}.canvas.portrait.explain-mechanism .headline-wrap{inset:23% 7% 57%;--headline:122px}.canvas.portrait.explain-mechanism .focal-art{top:42%;right:7%;width:86%}
.canvas.portrait.regenerative-possibility .subjects{inset:53% 0 0;height:39%}.canvas.portrait.regenerative-possibility .headline-wrap{inset:23% 7% 57%;--headline:126px}.canvas.portrait.regenerative-possibility .focal-art{top:40%;right:13%;width:74%}
.square.canvas,.feed.canvas{--headline:78px}.square.canvas .headline-wrap,.feed.canvas .headline-wrap{inset:16% 8% 54%;--headline:86px}.square.canvas .subjects,.feed.canvas .subjects{inset:48% 0 0;height:48%;gap:2%}.square.canvas .focal-art,.feed.canvas .focal-art{display:none}.square.canvas .series,.feed.canvas .series{display:none}.square.canvas footer,.feed.canvas footer{left:6%;bottom:5%;font-size:18px}.square.canvas header,.feed.canvas header{font-size:24px}
`;
