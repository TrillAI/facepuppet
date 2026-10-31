#!/usr/bin/env node
/* =====================================================================
   FaceMirror · main puppet build
   Inlines src/math.js and src/puppet/*.js into puppet.html — the
   advanced Canvas-2D demo page. index.html is NOT generated: it is the
   standalone single-file Three.js app (validated by check-index.mjs).
   No bundler: the output is readable and view-source-able; serve it
   over HTTP(S) for webcam and module access.

   usage:  node tools/build.mjs [--check]
   ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const SCRIPTS = [
  'src/math.js',
  'src/puppet/engine.js',
  'src/puppet/render.js',
  'src/puppet/ui.js'
];
/* puppet.html is generated from src/. index.html is hand-maintained as the
   dependency-free single-file build and must never be overwritten here. */
const OUTPUTS = { 'puppet.html': 'puppet' };

async function inlineOne(rel) {
  const code = await readFile(join(rootDir, rel), 'utf8');
  if (code.includes('</script')) throw new Error(`${rel} contains a literal </script — it cannot be inlined safely`);
  return `<script data-src="${rel}">\n${code}\n</script>\n`;
}

/* Render the puppet page in memory — the single source of truth for the
   generated entry point, so a stale page can never pass current. */
export async function render() {
  const src = await readFile(join(rootDir, 'src/puppet/puppet.src.html'), 'utf8');
  const blobs = [];
  for (const rel of SCRIPTS) blobs.push(await inlineOne(rel));
  const page = src.replace(/<!--@include[^>]*-->/g, () => blobs.shift());
  if (page.includes('@include')) throw new Error('not every @include marker was replaced');
  return { puppet: page };
}

export async function build() {
  const pages = await render();
  await Promise.all(Object.entries(OUTPUTS).map(([name, key]) => writeFile(join(rootDir, name), pages[key], 'utf8')));
  return { bytes: Buffer.byteLength(pages.puppet), files: SCRIPTS.length, outputs: Object.keys(OUTPUTS) };
}

/* --check: is the committed puppet.html byte-identical to the source? */
export async function stale() {
  const pages = await render();
  const staleFiles = [];
  for (const [name, key] of Object.entries(OUTPUTS)) {
    const have = await readFile(join(rootDir, name), 'utf8').catch(() => null);
    if (have !== pages[key]) staleFiles.push(name);
  }
  return staleFiles;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (checkOnly) {
    const bad = await stale();
    if (bad.length) {
      console.error(`check: STALE — ${bad.join(', ')} does not match src/. Run \`npm run build:puppet\`.`);
      process.exit(1);
    }
    console.log('check: puppet.html matches src/puppet/puppet.src.html exactly');
  } else {
    const r = await build();
    console.log(`built ${r.outputs.join(" + ")} (puppet.html ${(r.bytes / 1024).toFixed(1)} kB, ${r.files} modules inlined)`);
  }
}
