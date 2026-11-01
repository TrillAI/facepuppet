#!/usr/bin/env node
/* =====================================================================
   FacePuppet launcher icon generator (developer tool)

   Draws the app icon at every launcher density and writes it into the
   Android project.  PNGs are committed, so a normal APK build never needs
   this script or @napi-rs/canvas:

     npm i --no-save @napi-rs/canvas
     node tools/make-icons.mjs            # write res + a preview sheet
     node tools/make-icons.mjs --sheet    # preview only (no writes)

   Outputs
     res/mipmap-<density>/ic_launcher.png            legacy icon (API 24/25)
     res/mipmap-<density>/ic_launcher_round.png      legacy round icon
     res/mipmap-<density>/ic_launcher_foreground.png adaptive foreground (108dp)
     res/mipmap-<density>/ic_launcher_background.png adaptive background (108dp)
     res/mipmap-<density>/ic_launcher_monochrome.png themed-icon layer (API 33)
     res/mipmap-anydpi-v26/ic_launcher{,_round}.xml
     res/mipmap-anydpi-v33/ic_launcher{,_round}.xml   (adds <monochrome>)

   The art is one composition — a marionette head with the open,
   teeth-filled mouth the app is about — drawn once at 1024 and resampled
   down, so every density is the same drawing, not five drawings.
   ===================================================================== */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const resDir = join(rootDir, 'android', 'res');
const sheetOnly = process.argv.includes('--sheet');

/* mdpi..xxxhdpi; the adaptive layers are 108dp, the legacy icon 48dp */
const DENS = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
/* 108dp of adaptive layer, at the scale the launcher density implies */
const dp108 = (legacyPx) => Math.round(108 * (legacyPx / 48));

const TAU = Math.PI * 2;
const C = {
  ink: '#0a1116', deep: '#10242b', teal: '#5eead4',
  skinHi: '#fbe0c6', skin: '#f2c8a4', skinLo: '#d59a71', skinDeep: '#b8784f',
  hair: '#241a17', hairHi: '#4a352c',
  lip: '#b25f60', lipDark: '#8d4143', mouth: '#2b0a10', tongue: '#a34450',
  tooth: '#fbf7ea', toothShade: '#e6dcc6', collar: '#173f45',
};

/* ---------- the drawing ------------------------------------------- */
/* Everything is laid out in units of S so one function serves every size. */

function backdrop(g, S) {
  const bg = g.createLinearGradient(0, 0, S * 0.7, S);
  bg.addColorStop(0, '#143740');
  bg.addColorStop(0.55, '#0d1e25');
  bg.addColorStop(1, C.ink);
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  /* a soft teal pool behind the head so the silhouette lifts off the plate */
  const pool = g.createRadialGradient(S * 0.52, S * 0.46, 0, S * 0.52, S * 0.46, S * 0.62);
  pool.addColorStop(0, 'rgba(94,234,212,.26)');
  pool.addColorStop(0.55, 'rgba(45,212,191,.09)');
  pool.addColorStop(1, 'rgba(45,212,191,0)');
  g.fillStyle = pool;
  g.fillRect(0, 0, S, S);
  /* faint diagonal sheen, top-left */
  const sheen = g.createLinearGradient(0, 0, S * 0.55, S * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,255,.075)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
}

/* two marionette strings dropping in from above the frame */
function strings(g, S) {
  g.save();
  g.lineCap = 'round';
  const grad = g.createLinearGradient(0, 0, 0, S * 0.3);
  grad.addColorStop(0, 'rgba(94,234,212,.15)');
  grad.addColorStop(1, 'rgba(94,234,212,.75)');
  g.strokeStyle = grad;
  g.lineWidth = S * 0.007;
  g.beginPath();
  g.moveTo(S * 0.215, -S * 0.02); g.lineTo(S * 0.452, S * 0.128);
  g.moveTo(S * 0.785, -S * 0.02); g.lineTo(S * 0.548, S * 0.128);
  g.stroke();
  /* the little ring the strings are tied to */
  g.strokeStyle = 'rgba(94,234,212,.85)';
  g.lineWidth = S * 0.011;
  g.beginPath(); g.arc(S * 0.5, S * 0.118, S * 0.026, 0, TAU); g.stroke();
  g.restore();
}

function head(g, S, mono) {
  /* a couple of degrees of head tilt: a marionette hangs, it does not pose */
  g.save();
  const px = S * 0.5, py = S * 0.63;
  g.translate(px, py);
  g.rotate(-0.055);
  g.translate(-px, -py);
  headArt(g, S, mono);
  g.restore();
}

function headArt(g, S, mono) {
  const cx = S * 0.5, cy = S * 0.478;
  const rx = S * 0.222, ry = S * 0.272;

  /* --- neck + collar, drawn first so the jaw sits on top --- */
  if (!mono) {
    const nk = g.createLinearGradient(cx, S * 0.72, cx, S * 0.95);
    nk.addColorStop(0, C.skinDeep);
    nk.addColorStop(1, '#9d6440');
    g.fillStyle = nk;
    g.beginPath();
    g.moveTo(cx - S * 0.072, S * 0.70);
    g.lineTo(cx + S * 0.072, S * 0.70);
    g.lineTo(cx + S * 0.098, S * 0.99);
    g.lineTo(cx - S * 0.098, S * 0.99);
    g.closePath(); g.fill();
    /* collar */
    const col = g.createLinearGradient(0, S * 0.86, 0, S);
    col.addColorStop(0, C.collar);
    col.addColorStop(1, '#0e2a2f');
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(cx - S * 0.30, S * 0.99);
    g.quadraticCurveTo(cx, S * 0.845, cx + S * 0.30, S * 0.99);
    g.closePath(); g.fill();
  }

  /* --- shadow under the chin, so the head sits on the neck --- */
  if (!mono) {
    const under = g.createRadialGradient(cx, S * 0.735, 0, cx, S * 0.735, rx * 0.9);
    under.addColorStop(0, 'rgba(40,18,12,.42)');
    under.addColorStop(1, 'rgba(40,18,12,0)');
    g.fillStyle = under;
    g.fillRect(cx - rx, S * 0.66, rx * 2, S * 0.16);
  }

  /* --- ears --- */
  g.fillStyle = mono ? '#000' : C.skinLo;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + s * rx * 0.96, cy + ry * 0.06, rx * 0.085, ry * 0.12, 0, 0, TAU);
    g.fill();
  }

  /* --- face --- */
  const skin = g.createLinearGradient(cx - rx, cy - ry, cx + rx * 0.8, cy + ry);
  if (mono) {
    skin.addColorStop(0, '#000'); skin.addColorStop(1, '#000');
  } else {
    skin.addColorStop(0, C.skinHi);
    skin.addColorStop(0.45, C.skin);
    skin.addColorStop(1, C.skinLo);
  }
  g.fillStyle = skin;
  g.beginPath();
  /* a jaw that is a little narrower than the cranium reads as a face, not an egg */
  g.moveTo(cx - rx, cy - ry * 0.28);
  g.bezierCurveTo(cx - rx * 1.02, cy - ry * 0.95, cx - rx * 0.52, cy - ry * 1.06, cx, cy - ry * 1.06);
  g.bezierCurveTo(cx + rx * 0.52, cy - ry * 1.06, cx + rx * 1.02, cy - ry * 0.95, cx + rx, cy - ry * 0.28);
  g.bezierCurveTo(cx + rx * 0.99, cy + ry * 0.42, cx + rx * 0.60, cy + ry * 0.88, cx + rx * 0.30, cy + ry * 1.0);
  g.bezierCurveTo(cx + rx * 0.14, cy + ry * 1.06, cx - rx * 0.14, cy + ry * 1.06, cx - rx * 0.30, cy + ry * 1.0);
  g.bezierCurveTo(cx - rx * 0.60, cy + ry * 0.88, cx - rx * 0.99, cy + ry * 0.42, cx - rx, cy - ry * 0.28);
  g.closePath(); g.fill();

  if (mono) {
    /* themed icons want one flat silhouette with the identity cut out of it */
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse(cx, cy - ry * 0.55, rx * 1.02, ry * 0.62, 0, Math.PI, TAU);
    g.fill();
    const mY = cy + ry * 0.575, mW = rx * 0.645, mH = ry * 0.250;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(cx - mW, mY - mH * 0.34);
    g.quadraticCurveTo(cx, mY - mH * 0.46, cx + mW, mY - mH * 0.34);
    g.quadraticCurveTo(cx, mY + mH * 1.22, cx - mW, mY - mH * 0.34);
    g.closePath();
    g.fill();
    g.restore();
    return;
  }

  /* --- cheek blush + temple shade: what stops the face reading as a sticker */
  g.save();
  g.beginPath();
  g.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  g.clip();
  for (const s of [-1, 1]) {
    const bl = g.createRadialGradient(cx + s * rx * 0.52, cy + ry * 0.30, 0, cx + s * rx * 0.52, cy + ry * 0.30, rx * 0.42);
    bl.addColorStop(0, 'rgba(226,116,96,.30)');
    bl.addColorStop(1, 'rgba(226,116,96,0)');
    g.fillStyle = bl;
    g.fillRect(cx - rx, cy, rx * 2, ry * 1.2);
  }
  const shade = g.createLinearGradient(cx - rx, 0, cx + rx, 0);
  shade.addColorStop(0, 'rgba(140,80,50,.13)');
  shade.addColorStop(0.40, 'rgba(140,80,50,0)');
  shade.addColorStop(0.78, 'rgba(140,80,50,0)');
  shade.addColorStop(1, 'rgba(140,80,50,.16)');
  g.fillStyle = shade;
  g.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  /* jaw volume: light falls off under the cheekbones onto the chin */
  const jaw = g.createRadialGradient(cx, cy + ry * 1.30, ry * 0.10, cx, cy + ry * 1.05, ry * 0.95);
  jaw.addColorStop(0, 'rgba(150,86,54,.26)');
  jaw.addColorStop(0.55, 'rgba(150,86,54,.10)');
  jaw.addColorStop(1, 'rgba(150,86,54,0)');
  g.fillStyle = jaw;
  g.fillRect(cx - rx, cy, rx * 2, ry * 1.2);
  /* forehead sheen */
  const fore = g.createRadialGradient(cx - rx * 0.25, cy - ry * 0.55, 0, cx - rx * 0.25, cy - ry * 0.55, rx * 0.75);
  fore.addColorStop(0, 'rgba(255,246,232,.30)');
  fore.addColorStop(1, 'rgba(255,246,232,0)');
  g.fillStyle = fore;
  g.fillRect(cx - rx, cy - ry, rx * 2, ry * 1.2);
  g.restore();

  /* --- hair: a swept cap with a fringe that falls over the brow --- */
  const hair = g.createLinearGradient(cx, cy - ry * 1.06, cx, cy - ry * 0.15);
  hair.addColorStop(0, C.hairHi);
  hair.addColorStop(0.45, C.hair);
  hair.addColorStop(1, '#170f0d');
  g.fillStyle = hair;
  g.beginPath();
  g.moveTo(cx - rx * 1.01, cy - ry * 0.44);
  g.bezierCurveTo(cx - rx * 1.04, cy - ry * 1.04, cx - rx * 0.56, cy - ry * 1.15, cx + rx * 0.02, cy - ry * 1.15);
  g.bezierCurveTo(cx + rx * 0.58, cy - ry * 1.15, cx + rx * 1.05, cy - ry * 1.00, cx + rx * 1.01, cy - ry * 0.42);
  /* fringe: swept left to right, clearing the brows */
  g.bezierCurveTo(cx + rx * 0.96, cy - ry * 0.62, cx + rx * 0.86, cy - ry * 0.74, cx + rx * 0.60, cy - ry * 0.72);
  g.bezierCurveTo(cx + rx * 0.30, cy - ry * 0.70, cx + rx * 0.16, cy - ry * 0.60, cx - rx * 0.06, cy - ry * 0.60);
  g.bezierCurveTo(cx - rx * 0.34, cy - ry * 0.60, cx - rx * 0.62, cy - ry * 0.64, cx - rx * 0.80, cy - ry * 0.56);
  g.bezierCurveTo(cx - rx * 0.92, cy - ry * 0.51, cx - rx * 0.98, cy - ry * 0.46, cx - rx * 1.01, cy - ry * 0.44);
  g.closePath(); g.fill();
  /* one clean highlight arc, no hair strands: they turn to mud at 48px */
  g.strokeStyle = 'rgba(150,110,86,.38)';
  g.lineWidth = S * 0.007;
  g.beginPath();
  g.moveTo(cx - rx * 0.62, cy - ry * 0.92);
  g.quadraticCurveTo(cx - rx * 0.02, cy - ry * 1.06, cx + rx * 0.52, cy - ry * 0.88);
  g.stroke();
  /* sideburn shadow along the temples */
  g.fillStyle = 'rgba(32,21,17,.38)';
  for (const sgn of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + sgn * rx * 0.965, cy - ry * 0.30, rx * 0.055, ry * 0.155, 0, 0, TAU);
    g.fill();
  }

  /* --- brows --- */
  g.strokeStyle = '#33241f';
  g.lineWidth = S * 0.015;
  g.lineCap = 'round';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * rx * 0.44, cy - ry * 0.395);
    g.quadraticCurveTo(cx + s * rx * 0.26, cy - ry * 0.475, cx + s * rx * 0.08, cy - ry * 0.40);
    g.stroke();
  }

  /* --- eyes: whites, teal-brown iris, catchlight --- */
  for (const s of [-1, 1]) {
    const ex = cx + s * rx * 0.335, ey = cy - ry * 0.175;
    g.fillStyle = '#fdf6ee';
    g.beginPath();
    g.ellipse(ex, ey, rx * 0.175, ry * 0.100, 0, 0, TAU);
    g.fill();
    const iris = g.createRadialGradient(ex, ey - ry * 0.01, 0, ex, ey, rx * 0.095);
    iris.addColorStop(0, '#6f9d86');
    iris.addColorStop(0.6, '#3c6b58');
    iris.addColorStop(1, '#22463a');
    g.fillStyle = iris;
    g.beginPath(); g.ellipse(ex, ey, rx * 0.090, ry * 0.078, 0, 0, TAU); g.fill();
    g.fillStyle = '#120d0b';
    g.beginPath(); g.ellipse(ex, ey, rx * 0.040, ry * 0.040, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.94)';
    g.beginPath(); g.ellipse(ex - rx * 0.030, ey - ry * 0.028, rx * 0.024, ry * 0.021, 0, 0, TAU); g.fill();
    /* upper lid line — the cheapest way to make an eye look open and alert */
    g.strokeStyle = 'rgba(60,40,32,.75)';
    g.lineWidth = S * 0.007;
    g.beginPath();
    g.moveTo(ex - rx * 0.17, ey - ry * 0.050);
    g.quadraticCurveTo(ex, ey - ry * 0.118, ex + rx * 0.17, ey - ry * 0.050);
    g.stroke();
  }

  /* --- nose: a bridge sheen and two nostrils.  A drawn nose outline at
     icon size always reads as a moustache, so there isn't one.       --- */
  const bridge = g.createLinearGradient(cx - rx * 0.08, 0, cx + rx * 0.10, 0);
  bridge.addColorStop(0, 'rgba(255,238,220,.22)');
  bridge.addColorStop(1, 'rgba(255,238,220,0)');
  g.fillStyle = bridge;
  g.beginPath();
  g.ellipse(cx - rx * 0.01, cy + ry * 0.13, rx * 0.075, ry * 0.135, 0, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(120,66,44,.55)';
  for (const sgn of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + sgn * rx * 0.085, cy + ry * 0.255, rx * 0.036, ry * 0.019, sgn * 0.25, 0, TAU);
    g.fill();
  }
  g.strokeStyle = 'rgba(150,90,60,.30)';
  g.lineWidth = S * 0.007;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - rx * 0.115, cy + ry * 0.275);
  g.quadraticCurveTo(cx, cy + ry * 0.315, cx + rx * 0.115, cy + ry * 0.275);
  g.stroke();

  /* --- the mouth: the product shot.  Open smile, both dental arches --- */
  const mY = cy + ry * 0.575, mW = rx * 0.645, mH = ry * 0.250;
  /* corners ride UP: without this the aperture reads as a gasp, not a grin */
  const ap = () => {
    g.beginPath();
    g.moveTo(cx - mW, mY - mH * 0.34);
    g.quadraticCurveTo(cx, mY - mH * 0.46, cx + mW, mY - mH * 0.34);
    g.quadraticCurveTo(cx, mY + mH * 1.22, cx - mW, mY - mH * 0.34);
    g.closePath();
  };
  /* lower lip, painted under the aperture */
  const lowerLip = () => {
    g.beginPath();
    g.moveTo(cx - mW * 0.98, mY - mH * 0.30);
    g.quadraticCurveTo(cx, mY + mH * 1.20, cx + mW * 0.98, mY - mH * 0.30);
    g.quadraticCurveTo(cx, mY + mH * 1.95, cx - mW * 0.98, mY - mH * 0.30);
    g.closePath();
  };
  /* shadow the mouth casts on the chin */
  const chin = g.createRadialGradient(cx, mY + mH * 0.9, 0, cx, mY + mH * 0.9, mW * 1.15);
  chin.addColorStop(0, 'rgba(120,50,40,.22)');
  chin.addColorStop(1, 'rgba(120,50,40,0)');
  g.fillStyle = chin;
  g.fillRect(cx - mW * 1.3, mY - mH, mW * 2.6, mH * 2.6);

  g.fillStyle = C.mouth;
  ap(); g.fill();

  g.save();
  ap(); g.clip();
  /* tongue, low in the cavity */
  g.fillStyle = C.tongue;
  g.beginPath();
  g.ellipse(cx, mY + mH * 0.72, mW * 0.52, mH * 0.34, 0, 0, TAU);
  g.fill();
  /* lower arch */
  const loTop = mY + mH * 0.34;
  g.fillStyle = C.toothShade;
  g.beginPath();
  g.moveTo(cx - mW * 0.82, loTop + mH * 0.44);
  g.quadraticCurveTo(cx, loTop + mH * 0.26, cx + mW * 0.82, loTop + mH * 0.44);
  g.lineTo(cx + mW * 0.82, loTop + mH * 0.56);
  g.quadraticCurveTo(cx, loTop + mH * 0.38, cx - mW * 0.82, loTop + mH * 0.56);
  g.closePath(); g.fill();
  /* upper arch: the big front teeth, brightest thing in the icon */
  const upGrad = g.createLinearGradient(0, mY - mH * 0.2, 0, mY + mH * 0.42);
  upGrad.addColorStop(0, '#ffffff');
  upGrad.addColorStop(0.6, C.tooth);
  upGrad.addColorStop(1, '#e3d8c0');
  g.fillStyle = upGrad;
  g.beginPath();
  g.moveTo(cx - mW * 0.92, mY - mH * 0.40);
  g.quadraticCurveTo(cx, mY - mH * 0.52, cx + mW * 0.92, mY - mH * 0.40);
  g.lineTo(cx + mW * 0.92, mY + mH * 0.18);
  g.quadraticCurveTo(cx, mY - mH * 0.02, cx - mW * 0.92, mY + mH * 0.18);
  g.closePath(); g.fill();
  /* tooth separations: five across, tapering at the corners */
  g.strokeStyle = 'rgba(120,104,80,.55)';
  g.lineWidth = S * 0.006;
  const sep = [-0.62, -0.32, -0.03, 0.29, 0.58];
  for (const sx of sep) {
    const t = Math.abs(sx);
    g.beginPath();
    g.moveTo(cx + mW * sx, mY - mH * (0.40 - t * 0.10));
    g.lineTo(cx + mW * sx, mY + mH * (0.16 - t * 0.02));
    g.stroke();
  }
  /* occlusion shadow where the arches meet */
  g.fillStyle = 'rgba(30,8,12,.26)';
  g.beginPath();
  g.moveTo(cx - mW, mY + mH * 0.16);
  g.quadraticCurveTo(cx, mY - mH * 0.04, cx + mW, mY + mH * 0.16);
  g.lineTo(cx + mW, mY + mH * 0.26);
  g.quadraticCurveTo(cx, mY + mH * 0.06, cx - mW, mY + mH * 0.26);
  g.closePath(); g.fill();
  g.restore();

  /* lips: painted lower lip, one clean outline, one specular streak */
  const lipFill = g.createLinearGradient(0, mY - mH * 0.4, 0, mY + mH * 1.5);
  lipFill.addColorStop(0, C.lipDark);
  lipFill.addColorStop(0.45, C.lip);
  lipFill.addColorStop(1, C.lipDark);
  g.fillStyle = lipFill;
  lowerLip(); g.fill();
  g.strokeStyle = C.lipDark;
  g.lineWidth = S * 0.021;
  ap(); g.stroke();
  g.strokeStyle = C.lip;
  g.lineWidth = S * 0.012;
  ap(); g.stroke();
  g.strokeStyle = 'rgba(255,214,196,.42)';
  g.lineWidth = S * 0.008;
  g.beginPath();
  g.moveTo(cx - mW * 0.50, mY + mH * 0.82);
  g.quadraticCurveTo(cx, mY + mH * 1.04, cx + mW * 0.50, mY + mH * 0.82);
  g.stroke();

  /* --- teal rim light down the left cheek: ties the subject to the plate --- */
  g.save();
  g.beginPath();
  g.ellipse(cx, cy, rx * 1.01, ry * 1.01, 0, 0, TAU);
  g.clip();
  const rim = g.createLinearGradient(cx - rx, 0, cx - rx * 0.86, 0);
  rim.addColorStop(0, 'rgba(127,240,221,.34)');
  rim.addColorStop(1, 'rgba(127,240,221,0)');
  g.fillStyle = rim;
  g.fillRect(cx - rx * 1.1, cy - ry, rx * 0.22, ry * 2);
  g.restore();
}

function vignette(g, S) {
  const v = g.createRadialGradient(S * 0.62, S * 0.40, S * 0.22, S * 0.5, S * 0.5, S * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = v;
  g.fillRect(0, 0, S, S);
}

/* ---------- layers ------------------------------------------------ */
function renderFull(S, { withBackdrop = true, withStrings = true, mono = false } = {}) {
  const cv = createCanvas(S, S), g = cv.getContext('2d');
  if (withBackdrop) backdrop(g, S);
  if (withStrings) strings(g, S);
  head(g, S, mono);
  if (withBackdrop) vignette(g, S);
  return cv;
}

/* adaptive foreground: same head, shrunk into the 66/108dp safe zone */
function renderForeground(S) {
  const cv = createCanvas(S, S), g = cv.getContext('2d');
  g.save();
  g.translate(S * 0.5, S * 0.5);
  g.scale(0.72, 0.72);
  g.translate(-S * 0.5, -S * 0.505);
  head(g, S, false);
  g.restore();
  return cv;
}

function renderMonochrome(S) {
  const cv = createCanvas(S, S), g = cv.getContext('2d');
  g.save();
  g.translate(S * 0.5, S * 0.5);
  g.scale(0.72, 0.72);
  g.translate(-S * 0.5, -S * 0.505);
  head(g, S, true);
  g.restore();
  return cv;
}

function renderBackground(S) {
  const cv = createCanvas(S, S), g = cv.getContext('2d');
  backdrop(g, S);
  vignette(g, S);
  return cv;
}

/* ---------- masking + resampling ---------------------------------- */
function shapePath(g, size, shape) {
  g.beginPath();
  if (shape === 'circle') {
    g.arc(size / 2, size / 2, size / 2, 0, TAU);
  } else {
    /* Android's legacy squircle-ish corner radius */
    const r = size * 0.225;
    g.moveTo(r, 0);
    g.lineTo(size - r, 0); g.arcTo(size, 0, size, r, r);
    g.lineTo(size, size - r); g.arcTo(size, size, size - r, size, r);
    g.lineTo(r, size); g.arcTo(0, size, 0, size - r, r);
    g.lineTo(0, r); g.arcTo(0, 0, r, 0, r);
    g.closePath();
  }
}

function maskInto(src, size, shape) {
  const cv = createCanvas(size, size), g = cv.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  /* two-step resample for the small sizes: 1024 -> 256 -> 48 keeps the
     eyes and the tooth edges from turning to mush                   */
  let drawn = src;
  if (size < 200) {
    const mid = createCanvas(256, 256), mg = mid.getContext('2d');
    mg.imageSmoothingQuality = 'high';
    mg.drawImage(src, 0, 0, 256, 256);
    drawn = mid;
  }
  g.drawImage(drawn, 0, 0, size, size);
  if (shape === 'square' && size === src.width) return cv;
  if (shape !== 'none') {
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = '#000';
    shapePath(g, size, shape);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    /* hairline edge light: the thing that makes a flat plate read as a
       physical tile on a launcher                                    */
    g.strokeStyle = 'rgba(255,255,255,.13)';
    g.lineWidth = Math.max(1, size * 0.008);
    shapePath(g, size, shape);
    g.stroke();
  }
  return cv;
}

const write = async (dir, name, canvas) => {
  await mkdir(join(resDir, dir), { recursive: true });
  const file = join(resDir, dir, name);
  await writeFile(file, await canvas.encode('png'));
  return file;
};

/* ---------- preview sheet ----------------------------------------- */
async function sheet(full) {
  const W = 1180, H = 560;
  const cv = createCanvas(W, H), g = cv.getContext('2d');
  g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b0f14'; g.fillRect(0, 0, W, 280);
  const icon = renderFull(1024);
  const fg = renderForeground(1024), bgc = renderBackground(1024);
  /* row 1: the icon on dark, at real phone sizes */
  let x = 40;
  for (const s of [192, 144, 96, 72, 48]) {
    const ic = maskInto(icon, s, 'square');
    g.drawImage(ic, x, 44 + (192 - s) / 2, s, s);
    x += s + 34;
  }
  /* round mask */
  const circ = maskInto(icon, 192, 'circle');
  g.drawImage(circ, x + 20, 44, 192, 192);
  x += 250;
  /* adaptive composite: background + foreground inside a circle mask */
  const comp = createCanvas(1024, 1024), cg = comp.getContext('2d');
  cg.drawImage(bgc, 0, 0);
  cg.drawImage(fg, 0, 0);
  g.drawImage(maskInto(comp, 192, 'circle'), x + 20, 44, 192, 192);
  g.drawImage(maskInto(comp, 192, 'square'), x + 250, 44, 192, 192);

  /* row 2: the raw art, so the drawing itself can be judged */
  g.fillStyle = '#6b7280'; g.font = '600 20px system-ui, sans-serif';
  g.fillText('legacy 192 / 144 / 96 / 72 / 48, round, adaptive (circle + squircle)', 40, 300);
  const big = maskInto(icon, 300, 'square');
  g.drawImage(big, 40, 320, 300, 300);
  g.drawImage(maskInto(comp, 300, 'circle'), 380, 320, 300, 300);
  const mono = maskInto(renderMonochrome(1024), 180, 'none');
  g.fillStyle = '#1f2937';
  g.beginPath(); g.arc(820, 435, 90, 0, TAU); g.fill();
  g.save();
  g.beginPath(); g.arc(820, 435, 90, 0, TAU); g.clip();
  g.drawImage(mono, 730, 345, 180, 180);
  g.restore();
  g.fillStyle = '#9ca3af'; g.font = '500 15px system-ui, sans-serif';
  g.fillText('themed (API 33)', 745, 555);
  await mkdir(join(rootDir, '.preview'), { recursive: true });
  await writeFile(join(rootDir, '.preview', 'icon-sheet.png'), await cv.encode('png'));
  return join(rootDir, '.preview', 'icon-sheet.png');
}

/* ---------- main --------------------------------------------------- */
const icon = renderFull(1024);
const round = renderFull(1024);
const fg = renderForeground(1024);
const bg = renderBackground(1024);
const monoArt = renderMonochrome(1024);

if (!sheetOnly) {
  for (const [d, px] of DENS) {
    await write(`mipmap-${d}`, 'ic_launcher.png', maskInto(icon, px, 'square'));
    await write(`mipmap-${d}`, 'ic_launcher_round.png', maskInto(round, px, 'circle'));
    await write(`mipmap-${d}`, 'ic_launcher_foreground.png', maskInto(fg, dp108(px), 'none'));
    await write(`mipmap-${d}`, 'ic_launcher_background.png', maskInto(bg, dp108(px), 'none'));
    await write(`mipmap-${d}`, 'ic_launcher_monochrome.png', maskInto(monoArt, dp108(px), 'none'));
  }
  const adaptive = (mono) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />${mono ? `
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />` : ''}
</adaptive-icon>
`;
  await mkdir(join(resDir, 'mipmap-anydpi-v26'), { recursive: true });
  await mkdir(join(resDir, 'mipmap-anydpi-v33'), { recursive: true });
  await writeFile(join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive(false));
  await writeFile(join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive(false));
  await writeFile(join(resDir, 'mipmap-anydpi-v33', 'ic_launcher.xml'), adaptive(true));
  await writeFile(join(resDir, 'mipmap-anydpi-v33', 'ic_launcher_round.xml'), adaptive(true));
  console.log('wrote legacy, round, adaptive, monochrome icons to android/res');
}
console.log('preview sheet:', await sheet());
