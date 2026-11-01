#!/usr/bin/env node
/* =====================================================================
   FacePuppet launcher icon generator (developer tool)

   Draws the app icon at every launcher density and writes it into the
   Android project.  PNGs are committed, so a normal APK build never needs
   this script or @napi-rs/canvas:

     npm i --no-save @napi-rs/canvas
     node tools/make-icons.mjs
   ===================================================================== */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const DENS = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];

function drawIcon(size) {
  const S = 1024;                       // draw big, downscale per density
  const cv = createCanvas(S, S), g = cv.getContext('2d');
  /* background */
  const bg = g.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#111722'); bg.addColorStop(1, '#0a0e15');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  /* teal halo */
  const halo = g.createRadialGradient(S * 0.5, S * 0.44, S * 0.08, S * 0.5, S * 0.5, S * 0.52);
  halo.addColorStop(0, 'rgba(94,234,212,.22)'); halo.addColorStop(1, 'rgba(94,234,212,0)');
  g.fillStyle = halo; g.fillRect(0, 0, S, S);
  /* head */
  const cx = S * 0.5, cy = S * 0.47, rx = S * 0.29, ry = S * 0.35;
  const skin = g.createLinearGradient(cx, cy - ry, cx, cy + ry);
  skin.addColorStop(0, '#f7dcc4'); skin.addColorStop(1, '#d9a482');
  g.fillStyle = skin;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.fill();
  /* hair cap */
  g.fillStyle = '#231a17';
  g.beginPath(); g.ellipse(cx, cy - ry * 0.62, rx * 1.02, ry * 0.62, 0, Math.PI, 2 * Math.PI); g.fill();
  /* eyes */
  for (const s of [-1, 1]) {
    const ex = cx + s * rx * 0.42, ey = cy - ry * 0.22;
    g.fillStyle = '#fbf7f2';
    g.beginPath(); g.ellipse(ex, ey, rx * 0.19, ry * 0.10, 0, 0, 7); g.fill();
    g.fillStyle = '#2f4a3a';
    g.beginPath(); g.arc(ex, ey, rx * 0.085, 0, 7); g.fill();
    g.fillStyle = '#0b0808';
    g.beginPath(); g.arc(ex, ey, rx * 0.038, 0, 7); g.fill();
  }
  /* open mouth with the two dental arches — the app's signature */
  const mw = rx * 1.16, my = cy + ry * 0.46;
  g.fillStyle = '#5e2a2c';
  g.beginPath(); g.ellipse(cx, my, mw * 0.5, ry * 0.16, 0, 0, 7); g.fill();
  g.fillStyle = '#1a0709';
  g.beginPath(); g.ellipse(cx, my, mw * 0.40, ry * 0.115, 0, 0, 7); g.fill();
  g.fillStyle = '#f4efe4';
  g.beginPath(); g.ellipse(cx, my - ry * 0.055, mw * 0.36, ry * 0.062, 0, Math.PI, 2 * Math.PI); g.fill();
  g.beginPath(); g.ellipse(cx, my + ry * 0.055, mw * 0.34, ry * 0.050, 0, 0, Math.PI); g.fill();
  for (let i = -1; i <= 1; i++) {
    g.strokeStyle = 'rgba(120,96,72,.55)'; g.lineWidth = S * 0.006;
    g.beginPath(); g.moveTo(cx + i * mw * 0.11, my - ry * 0.115); g.lineTo(cx + i * mw * 0.11, my - ry * 0.01); g.stroke();
    g.beginPath(); g.moveTo(cx + i * mw * 0.10, my + ry * 0.01); g.lineTo(cx + i * mw * 0.10, my + ry * 0.105); g.stroke();
  }
  /* motion arrows: it is a puppet driven by your head */
  g.strokeStyle = 'rgba(94,234,212,.85)'; g.lineWidth = S * 0.022; g.lineCap = 'round';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(cx, cy, rx * 1.30, s > 0 ? -0.45 : Math.PI - 0.45, s > 0 ? 0.45 : Math.PI + 0.45);
    g.stroke();
  }
  const out = createCanvas(size, size);
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(cv, 0, 0, size, size);
  /* rounded mask like the launcher applies */
  const r = createCanvas(size, size), rg = r.getContext('2d');
  rg.beginPath();
  const rad = size * 0.22;
  rg.moveTo(rad, 0); rg.lineTo(size - rad, 0); rg.quadraticCurveTo(size, 0, size, rad);
  rg.lineTo(size, size - rad); rg.quadraticCurveTo(size, size, size - rad, size);
  rg.lineTo(rad, size); rg.quadraticCurveTo(0, size, 0, size - rad);
  rg.lineTo(0, rad); rg.quadraticCurveTo(0, 0, rad, 0); rg.closePath();
  rg.clip();
  rg.drawImage(out, 0, 0);
  return r;
}

for (const [dens, size] of DENS) {
  const dir = join(rootDir, 'android/res', 'mipmap-' + dens);
  await mkdir(dir, { recursive: true });
  const png = await drawIcon(size).encode('png');
  await writeFile(join(dir, 'ic_launcher.png'), png);
  console.log('wrote', join('android/res/mipmap-' + dens, 'ic_launcher.png'), size + 'px');
}
