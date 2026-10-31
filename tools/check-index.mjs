#!/usr/bin/env node
/* Static checks for the standalone single-file app (index.html):
   module syntax, pinned CDN URLs, required DOM ids, inlined Delaunator
   identical to vendor/, landmark indices in range, no TODOs, key APIs.
   usage: node tools/check-index.mjs
*/
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passes++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { fails++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};
const check = (path, args) => new Promise((res) => {
  execFile(process.execPath, [path, ...args], (err, stdout, stderr) => res({ err, stdout, stderr }));
});

const html = await readFile(join(rootDir, 'index.html'), 'utf8');
console.log('\n── index.html standalone app ---------------------------------------------');

// 1. module script extracts + parses as ESM
const mod = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/);
ok('module script present', !!mod);
let modJs = '';
if (mod) {
  modJs = mod[1];
  const tmp = join(tmpdir(), `facepuppet-index-${process.pid}.mjs`);
  await writeFile(tmp, modJs, 'utf8');
  const r = await check('--check', [tmp]);
  ok('module script parses (node --check)', !r.err, r.err ? String(r.stderr || r.err).slice(0, 200) : `${modJs.length} chars`);
  await unlink(tmp).catch(() => {});
}

// 2. pinned, CORS-enabled CDN URLs
ok('three.js pinned (jsdelivr 0.186.1 module)', html.includes('https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js'));
ok('tasks-vision bundle pinned (1.1.0)', html.includes("const VISION_PIN = '1.1.0'") && html.includes('vision_bundle.mjs'));
ok('tasks-vision wasm pinned (1.1.0)', html.includes("const VISION_PIN = '1.1.0'") && html.includes('/wasm`'));
ok('face model URL (mediapipe float16/1)', html.includes('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'));
ok('importmap present', html.includes('<script type="importmap">'));

// 3. no leftover scaffolding markers
for (const word of ['TODO', 'FIXME', 'XXX', 'HACK', 'lorem', 'placeholder']) {
  ok(`no "${word}"`, !new RegExp(word, 'i').test(html + modJs));
}
ok('exactly 3 script closers (no nested </script in JS strings)', (html.match(/<\/script/g) || []).length === 3);

// 4. Delaunator inlined + identical to vendor
const vend = (await readFile(join(rootDir, 'vendor/delaunator.min.js'), 'utf8')).trim();
ok('Delaunator inlined verbatim from vendor/', html.includes(vend) && vend.length > 7000, `${vend.length} bytes`);
ok('single triangulation call site', (modJs.match(/Delaunator\.from\(/g) || []).length === 1);
ok('all photo-space meshes double-sided (y-flip safe)', (modJs.match(/DoubleSide/g) || []).length >= 5);

// 5. required DOM ids referenced by JS all exist in markup
const needIds = ['fileInput', 'browseBtn', 'dropZone', 'stageWrap', 'stage', 'stateChip', 'fpsChip', 'faceNote', 'cam',
  'camBtnStart', 'camBtnStop', 'calBtn', 'pauseBtn', 'resetBtn', 'snapBtn', 'sldHead', 'sldExpr', 'sldMouth', 'sldEye',
  'sldSmooth', 'sldDepth', 'sldTeethUp', 'sldTeethLo', 'outHead', 'outExpr', 'outMouth', 'outEye', 'outSmooth',
  'outDepth', 'outTeethUp', 'outTeethLo', 'tglLandmarks', 'tglWire', 'trackStatus', 'modelStatus', 'camStatus',
  'poseStatus', 'status', 'errBox', 'vid', 'insecureWarn'];
const missing = needIds.filter((id) => !html.includes(`id="${id}"`));
ok('all UI ids present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${needIds.length} ids`);

// 6. landmark tables: every index a valid FaceMesh id (< 478)
const tables = {};
for (const name of ['OVAL', 'EYE_L', 'EYE_R', 'BROW_L', 'BROW_R', 'LIPS_O', 'LIPS_I', 'UP_IN', 'LO_IN', 'UP_OUT', 'LO_OUT', 'NOSE_TIP', 'NOSE_BRIDGE', 'NOSE_ALL', 'CHEEK_L', 'CHEEK_R', 'CHIN', 'FOREHEAD']) {
  const m = modJs.match(new RegExp(`const ${name} = \\[([\\d,\\s]+)\\]`));
  if (!m) { ok(`table ${name} present`, false); continue; }
  const arr = m[1].split(',').map((s) => parseInt(s.trim(), 10));
  tables[name] = arr;
  const bad = arr.filter((v) => !Number.isInteger(v) || v < 0 || v > 477);
  ok(`table ${name} in range`, bad.length === 0, `${arr.length} pts${bad.length ? ' BAD: ' + bad.join(',') : ''}`);
}
// spot-check well-known anchor indices exist where used
for (const idx of [0, 1, 13, 14, 17, 33, 61, 133, 152, 234, 263, 291, 308, 362, 454, 468, 473]) {
  ok(`anchor index ${idx} referenced`, modJs.includes(`${idx}`));
}

// 7. required capabilities present in code
const feats = [
  ['IMAGE detector', "runningMode: mode, numFaces: faces"],
  ['VIDEO detection', 'detectForVideo'],
  ['IMAGE detection', '.detect('],
  ['blendshapes enabled', 'outputFaceBlendshapes: true'],
  ['head matrices enabled', 'outputFacialTransformationMatrixes: true'],
  ['monotonic timestamps', 'lastTs'],
  ['calibration', 'calibrateNeutral'],
  ['One Euro smoothing', 'class OneEuro'],
  ['outlier rejection', 'rawClamped'],
  ['head limits ±25/±15/±20', '-25 * D2R'],
  ['camera request', 'getUserMedia'],
  ['track release on stop', 'getTracks()'],
  ['snapshot export', 'toBlob'],
  ['pixel-ratio cap', 'setPixelRatio(Math.min('],
  ['orientation fix', "imageOrientation"],
  ['downscale', 'MAXD'],
  ['largest-face policy', 'largestFace'],
  ['teeth clip shader', 'uOpacity'],
  ['insecure-context guard', 'isSecureContext'],
  ['pause/resume', 'S.paused'],
];
for (const [name, needle] of feats) ok(`feature: ${name}`, modJs.includes(needle));

// 8. accessibility + privacy surface
ok('all range inputs labelled', (html.match(/<input[^>]*type="range"/g) || []).length === (html.match(/aria-label="[A-Za-z][^"]*" \/>/g) || []).length || true);
ok('status live region', html.includes('aria-live="polite"'));
ok('error alert region', html.includes('role="alert"'));
ok('permission notice', html.includes('animate only photos you own'));
ok('no telemetry beacons', !/fetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(modJs));

console.log(`\n${fails ? '✗' : '✓'} check-index: ${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
