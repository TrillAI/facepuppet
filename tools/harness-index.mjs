#!/usr/bin/env node
/* Headless runtime test for the standalone index.html app.
   Executes the REAL module code in Node with DOM/GL mocks: boots the app,
   builds a portrait from synthetic landmarks, drives detection-less frames,
   injects fake tracker signals, and asserts the deform + layer pipeline
   stays finite and leak-free. No network, no camera, no GPU needed.
   usage: node tools/harness-index.mjs
*/
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passes++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { fails++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};
const allFinite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

// ---------- controllable clock + rAF ----------
let mockNow = 1000;
globalThis.performance = { now: () => mockNow };
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };

// ---------- DOM mocks ----------
function fake2d() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (typeof k === 'string') return () => {};
      return undefined;
    },
    set() { return true; }
  });
}
function fakeCanvas(w = 300, h = 150) {
  return { width: w, height: h, style: {}, _c: null,
    getContext(kind) { if (kind === '2d') return this._c || (this._c = fake2d()); return null; },
    addEventListener() {}, toBlob() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; } };
}
function fakeEl(id) {
  return { id, textContent: '', innerHTML: '', value: '1', checked: false, disabled: false,
    style: {}, dataset: {}, files: null, width: 300, height: 150, _l: {}, _c: null,
    srcObject: null, readyState: 0, currentTime: 0, videoWidth: 0, videoHeight: 0,
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    addEventListener(ev, fn) { (this._l[ev] || (this._l[ev] = [])).push(fn); },
    removeEventListener() {},
    fire(ev, arg) { for (const f of this._l[ev] || []) f(arg || { preventDefault() {} }); },
    appendChild(c) { return c; }, click() { this.fire('click'); },
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return this._c || (this._c = fake2d()); },
    play() { return Promise.resolve(); }, pause() {} };
}
const elMap = new Map();
globalThis.document = {
  getElementById(id) { if (!elMap.has(id)) elMap.set(id, fakeEl(id)); return elMap.get(id); },
  createElement(tag) { return tag === 'canvas' ? fakeCanvas() : fakeEl(''); },
  createTextNode(text) { return { textContent: String(text) }; },
  addEventListener() {}, hidden: false, readyState: 'complete'
};
globalThis.window = { isSecureContext: true, devicePixelRatio: 1, addEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

// ---------- load vendor Delaunator (UMD -> globalThis) ----------
await import('../vendor/delaunator.min.js');
ok('delaunator UMD loads in Node', typeof globalThis.Delaunator === 'function' && !!globalThis.Delaunator.from);

// ---------- load the real app module with hooks ----------
const html = await readFile(join(rootDir, 'index.html'), 'utf8');
const mod = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/);
if (!mod) { console.log('  FAIL module extract'); process.exit(1); }
let src = mod[1].replace(`from 'three'`, `from './mock-three.mjs'`);
const hook = `\nglobalThis.FPTEST = { S, buildPortrait, updateSignals, deform, geoPose, largestFace, calibrateNeutral, OneEuro, tick, els };\nboot().catch(e => { globalThis.FPTEST.bootErr = e; });\n`;
if (!src.trimEnd().endsWith('boot();')) { console.log('  FAIL boot() tail not found'); process.exit(1); }
src = src.replace(/\nboot\(\);\s*$/, hook);
const tmp = join(rootDir, 'tools', '.tmp-index-app.mjs');
await writeFile(tmp, src, 'utf8');
let appErr = null;
try { await import('./.tmp-index-app.mjs'); }
catch (e) { appErr = e; }
ok('app module imports without throwing', !appErr, appErr ? String(appErr && appErr.stack || appErr).slice(0, 300) : '');
await new Promise((r) => setTimeout(r, 60)); // let boot() settle (model import fails offline, gracefully)
const T = globalThis.FPTEST;
ok('boot completed (model fails gracefully offline)', !!T && !T.bootErr, T && T.bootErr ? String(T.bootErr).slice(0, 160) : '');
ok('model status shows failure without crash', T && T.els.modelStatus.textContent === 'failed');
ok('camera start blocked gracefully without mediaDevices', await (async () => {
  T.els.camBtnStart.disabled = false;
  T.els.camBtnStart.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  return T.S.camOn === false;
})());

// ---------- synthetic 478-point face ----------
function synthFace() {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const L = [];
  for (let i = 0; i < 478; i++) L.push({ x: 0.3 + rnd() * 0.4, y: 0.25 + rnd() * 0.5, z: -0.008 + (rnd() - 0.5) * 0.02 });
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  OVAL.forEach((idx, k) => {
    const a = (k / OVAL.length) * Math.PI * 2 - Math.PI / 2;
    L[idx] = { x: 0.5 + Math.cos(a) * 0.16, y: 0.5 + Math.sin(a) * 0.24, z: 0 };
  });
  const eye = (cx, cy, ring) => {
    ring.forEach((idx, k) => {
      const a = (k / ring.length) * Math.PI * 2;
      L[idx] = { x: cx + Math.cos(a) * 0.035, y: cy + Math.sin(a) * 0.011, z: -0.02 };
    });
  };
  eye(0.42, 0.42, [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]);
  eye(0.58, 0.42, [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]);
  L[468] = { x: 0.42, y: 0.42, z: -0.03 }; L[473] = { x: 0.58, y: 0.42, z: -0.03 };
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46].forEach((idx, k) => { L[idx] = { x: 0.375 + k * 0.01, y: 0.35, z: -0.02 }; });
  [300, 293, 334, 296, 336, 285, 295, 282, 283, 276].forEach((idx, k) => { L[idx] = { x: 0.535 + k * 0.01, y: 0.35, z: -0.02 }; });
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185].forEach((idx, k, arr) => {
    const a = (k / arr.length) * Math.PI * 2;
    L[idx] = { x: 0.5 + Math.cos(a) * 0.06, y: 0.62 + Math.sin(a) * 0.016, z: -0.015 };
  });
  [78, 82, 13, 312, 308, 317, 14, 87].forEach((idx, k, arr) => {
    const a = (k / arr.length) * Math.PI * 2;
    L[idx] = { x: 0.5 + Math.cos(a) * 0.045, y: 0.62 + Math.sin(a) * 0.004, z: -0.015 };
  });
  L[1] = { x: 0.5, y: 0.52, z: -0.06 }; L[152] = { x: 0.5, y: 0.74, z: 0 };
  L[234] = { x: 0.34, y: 0.52, z: 0.03 }; L[454] = { x: 0.66, y: 0.52, z: 0.03 };
  L[10] = { x: 0.5, y: 0.27, z: 0.02 };
  return L;
}
const faceA = synthFace();
const faceB = synthFace().map((p) => ({ x: 0.1 + p.x * 0.3, y: 0.1 + p.y * 0.3, z: p.z })); // smaller face

console.log('\n── portrait build ----------------------------------------------------------');
const photo1 = fakeCanvas(640, 480);
let buildErr = null;
try { T.buildPortrait(faceA, photo1, 1); } catch (e) { buildErr = e; }
ok('buildPortrait runs on synthetic landmarks', !buildErr, buildErr ? String(buildErr && buildErr.stack || buildErr).slice(0, 300) : '');
let m = T.S.mesh;
ok('mesh has 550 verts (478 + 72 boundary)', !!m && m.N === 550, m ? `N=${m.N}` : '');
ok('triangle index valid', !!m && m.headMesh.geometry.index.count > 100 &&
  (() => { const ix = m.headMesh.geometry.index.array; for (let i = 0; i < ix.length; i++) if (ix[i] >= m.N) return false; return true; })(),
  m ? `${m.headMesh.geometry.index.count / 3 | 0} tris` : '');
ok('weights finite', !!m && allFinite(m.headW) && allFinite(m.jawW) && allFinite(m.base));
ok('head weights span pinned..full', !!m && Math.min(...m.headW) < 0.05 && Math.max(...m.headW) > 0.95);
ok('multi-face note path', (() => { T.buildPortrait(faceA, photo1, 3); return /3 faces/.test(T.els.faceNote.textContent); })());
// NOTE: the multi-face check above rebuilt the portrait; re-fetch the live mesh.
m = T.S.mesh;
const sceneKids = T.S.scene.children.length;
// Simulate a live camera for the signal phases (detection safely no-ops:
// the fake video element never has frames, so runDetection returns early).
T.S.camOn = true;

// ---------- frames without camera ----------
console.log('\n── idle frames (no camera) -------------------------------------------------');
const step = (ms = 16) => { mockNow += ms; rafCb(); };
let frameErr = null;
try { for (let i = 0; i < 10; i++) step(); } catch (e) { frameErr = e; }
ok('10 idle frames run clean', !frameErr, frameErr ? String(frameErr && frameErr.stack || frameErr).slice(0, 300) : '');
ok('idle deform finite + neutral overlays hidden', allFinite(m.deformed) && T.S.openEnv < 0.05 && !m.teethUpMesh.visible);

// ---------- injected tracking signals ----------
console.log('\n── injected signals (jaw / blink / yaw) --------------------------------------');
T.S.neutral = { bs: {}, yaw: 0, pitchV: 0, roll: 0, txf: 0, tyf: 0, eyeD: 0.16, cx: 0.5, cy: 0.42 };
T.S.trackerCache = { bs: { jawOpen: 0.9 }, yawG: 0, pitchV: 0, rollG: 0, eyeD: 0.16, cx: 0.5, cy: 0.42, mp: null };
T.S.lastDetect = mockNow;
try { for (let i = 0; i < 40; i++) step(); } catch (e) { frameErr = e; }
ok('jaw frames run clean', !frameErr);
ok('trust ramps on detection', T.S.trust > 0.9, `trust=${T.S.trust.toFixed(2)}`);
ok('mouth opens (openEnv rises)', T.S.openEnv > 0.25, `open=${T.S.openEnv.toFixed(2)}`);
ok('teeth + cavity engage with finite clip', m.teethUpMesh.visible && m.teethLoMesh.visible && m.cavMesh.visible &&
  allFinite([m.teethUpMesh.material.uniforms.uC.value.x, m.teethUpMesh.material.uniforms.uR.value.y,
    m.teethUpMesh.material.uniforms.uOpacity.value]) && allFinite(m.deformed));
T.S.trackerCache.bs = { jawOpen: 0.9, eyeBlinkLeft: 1, eyeBlinkRight: 1 };
T.S.lastDetect = mockNow; // detection keeps arriving during each phase
for (let i = 0; i < 25; i++) step();
ok('blinks close lids', m.lidLMesh.visible && m.lidRMesh.visible);
T.S.trackerCache.bs = { jawOpen: 0.9 };
T.S.trackerCache.yawG = 0.5;
T.S.lastDetect = mockNow;
for (let i = 0; i < 30; i++) step();
ok('yaw follows + clamps to ±25°', T.S.yaw > 0.05 && T.S.yaw <= 25 * Math.PI / 180 + 1e-6, `yaw=${(T.S.yaw * 180 / Math.PI).toFixed(1)}°`);
const noseDx = Math.abs(m.deformed[1 * 3] - m.base[1 * 3]);
// exact rotation check: Ry-only turn about the pivot with weak perspective
const rx = m.base[3] - m.pivot[0], rz = m.base[5];
const cY = Math.cos(T.S.yaw), sY = Math.sin(T.S.yaw);
const x3 = rx * cY + rz * sY, z3 = -rx * sY + rz * cY;
const sPersp = (3.2 * m.fw) / (3.2 * m.fw - z3);
const expectDx = Math.abs(m.pivot[0] + x3 * sPersp - m.base[3]);
ok('head turn matches Ry perspective math, background pinned',
  Math.abs(noseDx - expectDx) < 0.6 && expectDx > 3 &&
  Math.abs(m.deformed[(m.N - 8) * 3] - m.base[(m.N - 8) * 3]) < 1e-6,
  `nose dx=${noseDx.toFixed(2)}px expected=${expectDx.toFixed(2)}px`);

// ---------- tracking loss ----------
console.log('\n── tracking loss -----------------------------------------------------------');
T.S.lastDetect = mockNow - 5000;
for (let i = 0; i < 150; i++) step();
ok('trust decays to zero', T.S.trust < 0.02, `trust=${T.S.trust.toFixed(3)}`);
ok('pose eases back to neutral', Math.abs(T.S.yaw) < 0.01 && Math.abs(m.deformed[1 * 3] - m.base[1 * 3]) < 2);

// ---------- pure helpers ----------
console.log('\n── helpers -----------------------------------------------------------------');
ok('largestFace picks the bigger box', T.largestFace([faceB, faceA]) === 1 && T.largestFace([faceA, faceB]) === 0);
ok('geoPose frontal ≈ 0 yaw', Math.abs(T.geoPose(faceA).yaw) < 0.05);
const turned = faceA.map((p) => ({ ...p }));
turned[1] = { x: 0.53, y: 0.52, z: 0.06 }; // nose toward image-right
ok('geoPose yaw sign (nose right -> +)', T.geoPose(turned).yaw > 0.1);
const oe = new T.OneEuro(2, 0.02, 1);
let v = 0; for (let i = 0; i < 600; i++) v = oe.run(i < 300 ? 0 : 1, i * 0.0167);
ok('OneEuro converges + ignores NaN', Math.abs(v - 1) < 0.03 && Number.isFinite(oe.run(NaN, 11)));

// ---------- UI controls ----------
console.log('\n── controls ----------------------------------------------------------------');
T.els.sldHead.value = '0.5'; T.els.sldHead.fire('input');
ok('head slider updates params', T.S.params.head === 0.5);
T.els.tglLandmarks.checked = true; T.els.tglLandmarks.fire('change');
step();
ok('landmark overlay toggles + fills', m.overlay.visible === true && allFinite(m.overlay.geometry.attributes.position.array));
T.els.tglWire.checked = true; T.els.tglWire.fire('change');
ok('wireframe toggles', m.headMesh.material.wireframe === true);
T.els.pauseBtn.disabled = false; T.els.pauseBtn.fire('click');
const frozen = m.deformed[1 * 3];
step(); step();
ok('pause freezes deform', m.deformed[1 * 3] === frozen && T.S.paused === true);
T.els.pauseBtn.fire('click');
ok('resume works', T.S.paused === false);
T.els.resetBtn.fire('click');
ok('reset restores defaults', T.S.params.head === 1 && T.S.neutral === null && m.overlay.visible === false);

// ---------- photo replacement frees resources ----------
console.log('\n── photo replacement ---------------------------------------------------------');
const oldTex = m.headTex;
T.buildPortrait(faceA, fakeCanvas(320, 240), 1);
ok('rebuild swaps textures', T.S.mesh.headTex !== oldTex);
ok('scene children stable (no leak)', T.S.scene.children.length === sceneKids, `${sceneKids} nodes`);
ok('stage resized to new photo', T.els.stage.width === 320 && T.els.stage.height === 240);

await unlink(tmp).catch(() => {});
console.log(`\n${fails ? '✗' : '✓'} harness-index: ${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
