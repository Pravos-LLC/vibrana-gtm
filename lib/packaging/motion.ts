/** Seekable motion: the thumbnail is the exact hold state, not a separately designed frame. */
export const MOTION_PRESETS = {
  reveal: { name: "Layer reveal", enterFrames: 24, exitFrames: 18 },
  editorial: { name: "Editorial reveal", enterFrames: 30, exitFrames: 18 },
  split: { name: "Two perspectives", enterFrames: 24, exitFrames: 24 },
} as const;
export type MotionPreset = keyof typeof MOTION_PRESETS;
export function motionState(frame: number, fps = 30, duration = 4, preset: MotionPreset = "reveal") {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || !Number.isFinite(duration) || fps <= 0 || duration < 2) throw new Error("Motion needs a finite frame, positive fps and duration >= 2 seconds");
  const f = Math.max(0, Math.min(frame, duration * fps));
  const enter = preset === "editorial" ? 1 : .8, exit = preset === "split" ? .8 : .6;
  const t = f / fps;
  const reveal = 1 - Math.pow(1 - Math.min(1, t / enter), 3);
  const depart = f >= duration * fps ? 1 : Math.max(0, Math.min(1, (t - (duration - exit)) / exit));
  const opacity = reveal * (1 - depart);
  return { opacity, offset: (1 - reveal) * 75 + depart * 75, scale: 1 + (1 - reveal) * .025, accent: reveal * (1 - depart) };
}
export function motionDocument(html: string, width: number, height: number, preset: MotionPreset) {
  const script = `const state=${motionState.toString()};let frame=30,playing=false,last=0;const fps=30,duration=4,total=fps*duration,preset=${JSON.stringify(preset)};const canvas=document.querySelector('.canvas');const slider=document.querySelector('#seek');
function fit(){const scale=Math.min(innerWidth/${width},(innerHeight-62)/${height});canvas.style.transform='scale('+Math.max(.01,scale)+')';document.querySelector('#stage').style.height=(innerHeight-62)+'px'}
window.packagingSeek=function(f){frame=Math.max(0,Math.min(total,Number(f)));slider.value=frame;const s=state(frame,fps,duration,preset);canvas.style.opacity=s.opacity;document.querySelectorAll('[data-layer]').forEach((el,i)=>{const layer=el.dataset.layer;el.style.opacity=1;let x=0,y=0,scale=1;if(layer==='subject'){const subjects=[...document.querySelectorAll('[data-layer="subject"]')];x=(subjects.indexOf(el)?1:-1)*s.offset}else if(layer==='headline'||layer==='names')y=s.offset*.5;else if(layer==='background')scale=s.scale;else if(layer==='accent')scale=s.accent;else if(layer==='backdrop')y=-s.offset*.6;el.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')'});document.querySelector('#frame').textContent=frame.toFixed(0)+' / '+total;return s};
slider.addEventListener('input',()=>{playing=false;window.packagingSeek(slider.value)});document.querySelector('#play').onclick=()=>begin(false);document.querySelector('#still').onclick=()=>{playing=false;window.packagingSeek(30)};document.querySelector('#outro').onclick=()=>begin(true);
let reverse=false,raf=0;function begin(backwards){cancelAnimationFrame(raf);reverse=backwards;frame=backwards?total:0;playing=true;last=0;window.packagingSeek(frame);raf=requestAnimationFrame(tick)}
function tick(now){if(!playing)return;if(!last){last=now;raf=requestAnimationFrame(tick);return}frame+=(now-last)/1000*fps*(reverse?-1:1);last=now;window.packagingSeek(frame);if(reverse?frame<=0:frame>=total){playing=false;return}raf=requestAnimationFrame(tick)}
addEventListener('resize',fit);fit();window.packagingSeek(frame);if(matchMedia('(prefers-reduced-motion: reduce)').matches)playing=false;`;
  const controls = '<div id="controls"><button id="play">Play title</button><button id="outro">Play outro</button><button id="still">Still / hold</button><input id="seek" type="range" min="0" max="120" value="30" aria-label="Animation frame"><output id="frame"></output></div>';
  const css = `body{background:#111;color:white;overflow:hidden}#stage{display:flex;align-items:center;justify-content:center;overflow:hidden}.canvas{flex:none;transform-origin:center}.canvas [data-layer]{transform-origin:center;will-change:transform,opacity}#controls{position:fixed;bottom:0;left:0;right:0;height:62px;display:flex;gap:12px;align-items:center;padding:12px;background:#191919;font:13px system-ui}#controls button{background:#333;color:white;border:1px solid #666;padding:8px;cursor:pointer}#seek{flex:1}#frame{min-width:80px}`;
  return html.replace('</head>', `<style>${css}</style></head>`).replace('<body>', '<body><div id="stage">').replace('</body>', `</div>${controls}<script>${script}</script></body>`);
}
