#!/usr/bin/env node
/* =====================================================================
   FaceMirror · offline preview renderer (developer tool)

   Renders the real engine + renderer into a Skia canvas in Node (via
   @napi-rs/canvas) on a synthetic photo, and writes PNGs to .preview/.
   Used to eyeball feature passes (teeth, lips, ears) without a browser:

     npm i --no-save @napi-rs/canvas
     node tools/preview.mjs [--out .preview] [--crop mouth]

   Not part of the app bundle and not required by `npm test`.
   ===================================================================== */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import Delaunator from 'delaunator';
import { synthFace, synthTessellation, toLandmarks } from './synthface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(rootDir, argOf('--out', '.preview'));

/* ---- a minimal canvas-only DOM ------------------------------------- */
globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') return createCanvas(2, 2);
    return { getContext: () => null, style: {}, appendChild() {} };
  }
};
globalThis.performance = { now: () => Date.now() };
globalThis.Delaunator = Delaunator;

const load = async (rel) => { (0, eval)(await readFile(join(rootDir, rel), 'utf8')); };
await load('src/math.js');
await load('src/puppet/engine.js');
await load('src/puppet/render.js');

/* ---- synthetic photo ------------------------------------------------ */
const W = 960, H = 1200, FACE_PX = 430;
const MOUTH_Y = 0.285;
/* Optional open mouth: push the inner lip ring apart so the render has a
   real aperture to fill with cavity + teeth (the closed synthetic layout
   collapses it to a 1 px slit and there is nothing to look at).        */
const OPEN = !argv.includes('--closed');
function expandMouth(P, k) {
  for (const i of [78, 82, 13, 312, 308, 317, 14, 87]) {
    const y = P[i][1];
    P[i] = [P[i][0], MOUTH_Y + (y - MOUTH_Y) * k, P[i][2]];
  }
  /* outer lip corners follow a little so the mouth is not a fish slit */
  for (const i of [61, 291, 76, 290, 62, 289, 306, 305]) {
    const p = P[i];
    P[i] = [p[0] * 1.06, p[1], p[2]];
  }
}
function photo(P) {
  const cv = createCanvas(W, H), g = cv.getContext('2d');
  const X = x => W / 2 + x * FACE_PX, Y = y => H * 0.48 + y * FACE_PX;
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#3b4752'); bg.addColorStop(1, '#151d26');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  /* shoulders */
  g.fillStyle = '#25333f';
  g.beginPath(); g.ellipse(W / 2, H * 1.03, W * 0.52, H * 0.28, 0, 0, 7); g.fill();
  /* hair shell */
  g.fillStyle = '#2c1d15';
  g.beginPath(); g.ellipse(X(0), Y(-0.10), 0.62 * FACE_PX, 0.70 * FACE_PX, 0, 0, 7); g.fill();
  /* neck */
  g.fillStyle = '#c99976';
  g.fillRect(X(-0.22), Y(0.30), 0.44 * FACE_PX, 0.55 * FACE_PX);
  /* face */
  const skin = g.createRadialGradient(X(-0.14), Y(-0.20), 0.06 * FACE_PX, X(0), Y(0), 0.70 * FACE_PX);
  skin.addColorStop(0, '#f6dcc2'); skin.addColorStop(0.55, '#e8bd9c'); skin.addColorStop(1, '#b9885f');
  g.fillStyle = skin;
  g.beginPath(); g.ellipse(X(0), Y(0), 0.51 * FACE_PX, 0.655 * FACE_PX, 0, 0, 7); g.fill();
  /* cheeks */
  for (const s of [-1, 1]) {
    const cg = g.createRadialGradient(X(s * 0.24), Y(0.10), 2, X(s * 0.24), Y(0.10), 0.16 * FACE_PX);
    cg.addColorStop(0, 'rgba(208,124,100,.28)'); cg.addColorStop(1, 'rgba(208,124,100,0)');
    g.fillStyle = cg; g.beginPath(); g.arc(X(s * 0.24), Y(0.10), 0.16 * FACE_PX, 0, 7); g.fill();
  }
  /* eyes: sclera, iris from the real iris landmarks, lid line, lashes */
  for (const s of [-1, 1]) {
    const ex = X(s * 0.205), ey = Y(-0.145);
    g.fillStyle = '#f8f4ef';
    g.beginPath(); g.ellipse(ex, ey, 0.090 * FACE_PX, 0.043 * FACE_PX, 0, 0, 7); g.fill();
    const ir = g.createRadialGradient(ex, ey - 0.004 * FACE_PX, 1, ex, ey, 0.036 * FACE_PX);
    ir.addColorStop(0, '#2b3a2c'); ir.addColorStop(0.6, '#4d6b52'); ir.addColorStop(1, '#1d2a1f');
    g.fillStyle = ir; g.beginPath(); g.arc(ex, ey, 0.036 * FACE_PX, 0, 7); g.fill();
    g.fillStyle = '#0c0908'; g.beginPath(); g.arc(ex, ey, 0.016 * FACE_PX, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(ex - 0.012 * FACE_PX, ey - 0.014 * FACE_PX, 0.008 * FACE_PX, 0, 7); g.fill();
    g.strokeStyle = '#43302a'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(ex, ey, 0.090 * FACE_PX, 0.043 * FACE_PX, 0, 0, 7); g.stroke();
    g.strokeStyle = '#3a2a20'; g.lineWidth = 8; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(X(s * 0.30), Y(-0.245)); g.quadraticCurveTo(X(s * 0.20), Y(-0.275), X(s * 0.075), Y(-0.250));
    g.stroke();
  }
  /* nose: shading along the bridge + alae from the nostril landmarks */
  g.fillStyle = 'rgba(160,105,78,.20)';
  g.beginPath(); g.ellipse(X(0.035), Y(0.045), 0.05 * FACE_PX, 0.09 * FACE_PX, 0.16, 0, 7); g.fill();
  for (const s of [-1, 1]) {
    g.fillStyle = 'rgba(96,54,42,.50)';
    g.beginPath(); g.ellipse(X(s * 0.035), Y(0.088), 0.020 * FACE_PX, 0.011 * FACE_PX, 0, 0, 7); g.fill();
  }
  /* lips: outer ring, then the aperture (inner ring) in mouth-interior tone */
  const ring = (idx) => {
    g.beginPath();
    idx.forEach((i, k) => k ? g.lineTo(X(P[i][0]), Y(P[i][1])) : g.moveTo(X(P[i][0]), Y(P[i][1])));
    g.closePath();
  };
  const LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  const lg = g.createLinearGradient(0, Y(MOUTH_Y - 0.07), 0, Y(MOUTH_Y + 0.07));
  lg.addColorStop(0, '#c07a70'); lg.addColorStop(0.45, '#a85f5c'); lg.addColorStop(1, '#8d4a4a');
  g.fillStyle = lg; ring(LO); g.fill();
  g.strokeStyle = 'rgba(88,44,40,.5)'; g.lineWidth = 2; ring(LO); g.stroke();
  const IN = [78, 82, 13, 312, 308, 317, 14, 87];
  g.fillStyle = '#20080b'; ring(IN); g.fill();
  return cv;
}

/* ---- build the puppet ---------------------------------------------- */
const P0 = synthFace();
if (OPEN) expandMouth(P0, 9);
const tess = synthTessellation(P0);
const adjacency = Array.from({ length: 478 }, () => new Set());
for (const e of tess) { if (e.start < 478 && e.end < 478) { adjacency[e.start].add(e.end); adjacency[e.end].add(e.start); } }
const adjList = adjacency.map(s => [...s]);

const src = photo(P0);
const head = globalThis.FMEngine.buildCanonical(toLandmarks(P0, W, H, FACE_PX), W, H, { adjacency: adjList });
const mesh = globalThis.FMEngine.buildMesh(head, { delaunay: Delaunator, tessellation: tess });
const canvas = createCanvas(W, H);
const ses = globalThis.FMRender.createSession();
globalThis.FMRender.sessionInit(ses, { source: src, canvas, head, mesh });

const st = (over) => Object.assign({
  t: 1, dt: 1 / 60, quality: 1, q: [0, 0, 0, 1],
  focal: 3.1, scale: 1, depthGain: 0.3, ox: 0, oy: 0,
  deltaCanonical: new Float32Array(478 * 3), jawOpen: 0, jawMeshGain: 1,
  limits: true, shade: 0, hairGain: 0, gaze: [[0, 0], [0, 0]], gazeGain: 1.9,
  lid: [0, 0], vis: 1, bright: 1.15, warmth: 0.35,
  showPoints: false, showMesh: false, origOnly: false, points: [], dragIndex: -1, hoverIndex: -1
}, over || {});

const frames = [];
function shot(name, over, opts = {}) {
  let dbg = null;
  for (let i = 0; i < 40; i++) dbg = globalThis.FMRender.sessionFrame(ses, st(over));
  const crop = opts.crop;
  let out = canvas;
  if (crop) {
    const [cx, cy, cw, ch, mag] = crop;
    const c2 = createCanvas(cw * mag, ch * mag), g2 = c2.getContext('2d');
    g2.imageSmoothingEnabled = false;
    g2.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw * mag, ch * mag);
    out = c2;
  }
  frames.push({ name, out, dbg });
  return dbg;
}

const jawFrames = [
  ['closed', 0], ['half', 0.35], ['open', 0.7], ['wide', 1.0]
];
for (const [nm, j] of jawFrames) {
  shot(`mouth-${nm}`, { jawOpen: j, q: globalThis.FM.quatFromYPR(0, 0, 0) },
       { crop: [W * 0.5 - 100, H * 0.5 + 100, 200, 100, 7] });
}
shot('mouth-open-turn', { jawOpen: 0.7, q: globalThis.FM.quatFromYPR(0.5, 0.05, 0) },
     { crop: [W * 0.5 - 190, H * 0.5 + 80, 380, 240, 3] });
shot('face-open', { jawOpen: 0.7 });

await mkdir(outDir, { recursive: true });
for (const f of frames) {
  const buf = await f.out.encode('png');
  await writeFile(join(outDir, f.name + '.png'), buf);
  const m = f.dbg && f.dbg.mouth;
  if (m) console.log(f.name.padEnd(18), `up ${m.upperTeeth} lo ${m.lowerTeeth} part ${(m.part || 0).toFixed(2)} h ${(m.h || 0).toFixed(2)} clip ${m.clip}`);
}
console.log('wrote', frames.length, 'frames to', outDir);

/* diagnostics */
if (argv.includes('--debug')) {
  for (const j of [0, 0.35, 0.7]) {
    for (let i = 0; i < 60; i++) globalThis.FMRender.sessionFrame(ses, st({ jawOpen: j }));
    const d = ses.lastDebug.mouth;
    console.log('jawOpen', j, 'jaw', (ses.jaw * 180 / Math.PI).toFixed(1), 'mw', d.mw.toFixed(1), 'gap', d.gap.toFixed(1), 'h', d.h.toFixed(2),
      'p13', ses.DST[26].toFixed(1), ses.DST[27].toFixed(1), 'p14', ses.DST[28].toFixed(1), ses.DST[29].toFixed(1));
  }
}
