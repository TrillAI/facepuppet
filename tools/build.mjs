#!/usr/bin/env node
/* =====================================================================
   FaceMirror · main puppet build
   Inlines src/math.js and src/puppet/*.js into puppet.html — the single
   app page. index.html is written as a tiny redirect stub so any bare
   visit lands on the puppet. No bundler: the output is readable and
   view-source-able; serve it over HTTP(S) for webcam and module access.

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
/* puppet.html IS the app. index.html only exists as a redirect stub so a
   bare domain hit lands on the puppet (the 3D studio is not shipped).   */
const REDIRECT = `<!doctype html>
<meta charset="utf-8">
<title>Face Puppet</title>
<meta http-equiv="refresh" content="0; url=puppet.html">
<link rel="canonical" href="puppet.html">
<p>Redirecting to <a href="puppet.html">puppet.html</a>…
`;
const OUTPUTS = { 'index.html': 'index', 'puppet.html': 'puppet' };

async function inlineOne(rel) {
  const code = await readFile(join(rootDir, rel), 'utf8');
  if (code.includes('</script')) throw new Error(`${rel} contains a literal </script — it cannot be inlined safely`);
  return `<script data-src="${rel}">\n${code}\n</script>\n`;
}

/* Render the main puppet page in memory — the single source of truth for
   both generated entry points, so a stale page can never pass current. */
export async function render() {
  const src = await readFile(join(rootDir, 'src/puppet/puppet.src.html'), 'utf8');
  const blobs = [];
  for (const rel of SCRIPTS) blobs.push(await inlineOne(rel));
  const page = src.replace(/<!--@include[^>]*-->/g, () => blobs.shift());
  if (page.includes('@include')) throw new Error('not every @include marker was replaced');
  return { index: REDIRECT, puppet: page };
}

export async function build() {
  const pages = await render();
  await Promise.all(Object.entries(OUTPUTS).map(([name, key]) => writeFile(join(rootDir, name), pages[key], 'utf8')));
  return { bytes: Buffer.byteLength(pages.puppet), files: SCRIPTS.length, outputs: Object.keys(OUTPUTS) };
}

/* --check: are both committed entry points byte-identical to the source? */
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
    console.log('check: index.html and puppet.html match src/puppet/puppet.src.html exactly');
  } else {
    const r = await build();
    console.log(`built ${r.outputs.join(" + ")} (puppet.html ${(r.bytes / 1024).toFixed(1)} kB, ${r.files} modules inlined)`);
  }
}
