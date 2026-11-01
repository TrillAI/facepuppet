#!/usr/bin/env node
/* =====================================================================
   FacePuppet · Android APK builder

   Produces a self-contained, offline APK: the page (puppet.html), the
   MediaPipe runtime, both WASM builds and the 478-landmark face model are
   packed into assets/ and served to the WebView from a private https
   origin (see android/smali/.../AssetClient.smali).

   Toolchain (no Android SDK, no Gradle, no network beyond npm/PyPI):
     · java          — https://pypi.org/project/jdk4py   (JRE, wheels)
     · apktool.jar   — npm @postar/apktool-node          (builds resources
                       with its bundled aapt2 and assembles smali -> dex)
     · apksigner.jar — npm @postar/apktool-node          (v1/v2/v3 signing)

   usage:
     node tools/build-apk.mjs [--no-stage] [--out release]

   Everything it downloads lands in .apk-tools/ (git-ignored); the APK is
   written to release/ (git-ignored, but a normal file you can install).
   ===================================================================== */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(rootDir, argOf('--out', 'release'));
const toolDir = join(rootDir, '.apk-tools');
const androidDir = join(rootDir, 'android');
const APK_NAME = 'FacePuppet.apk';

const say = (m) => console.log('  ' + m);
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} failed\n${out}`);
  }
};

/* ---- java ---------------------------------------------------------- */
async function findJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin'));
  try {
    const { execFileSync } = await import('node:child_process');
    const py = execFileSync('python3', ['-c', 'import jdk4py; print(jdk4py.JAVA_HOME)'], { encoding: 'utf8' });
    candidates.push(join(py.trim(), 'bin'));
  } catch (e) { /* jdk4py not installed */ }
  for (const dir of candidates) {
    for (const exe of ['java', 'keytool']) {
      const p = join(dir, exe);
      if (existsSync(p)) return { java: join(dir, 'java'), keytool: join(dir, 'keytool'), home: dirname(dir) };
    }
  }
  throw new Error('no Java runtime found — run: pip install jdk4py   (or set JAVA_HOME)');
}

/* ---- tool jars from npm -------------------------------------------- */
async function ensureJars() {
  const apktool = join(toolDir, 'apktool.jar');
  const apksigner = join(toolDir, 'apksigner.jar');
  if (existsSync(apktool) && existsSync(apksigner)) return { apktool, apksigner };
  await mkdir(toolDir, { recursive: true });
  say('fetching apktool + apksigner jars from npm (@postar/apktool-node)');
  run('npm', ['pack', '@postar/apktool-node', '--silent', '--pack-destination', toolDir], { cwd: rootDir });
  const tgz = (await readdir(toolDir)).find(f => f.startsWith('postar-apktool-node') && f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  run('tar', ['xzf', join(toolDir, tgz), '-C', toolDir, 'package/lib/apktool.jar', 'package/lib/apksigner.jar']);
  await cp(join(toolDir, 'package/lib/apktool.jar'), apktool);
  await cp(join(toolDir, 'package/lib/apksigner.jar'), apksigner);
  await rm(join(toolDir, 'package'), { recursive: true, force: true });
  await rm(join(toolDir, tgz), { force: true });
  return { apktool, apksigner };
}

/* ---- keystore ------------------------------------------------------ */
async function ensureKeystore(java) {
  const ks = join(androidDir, 'facepuppet.keystore');
  if (existsSync(ks)) return ks;
  say('creating a self-signed release key (android/facepuppet.keystore)');
  run(java.keytool, ['-genkeypair', '-keystore', ks, '-alias', 'facepuppet',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', 'facepuppet', '-keypass', 'facepuppet',
    '-dname', 'CN=FacePuppet, O=TrillAI, C=US']);
  return ks;
}

/* ---- asset bundle -------------------------------------------------- */
async function stageAssets() {
  const dest = join(androidDir, 'assets');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  /* the app page, exactly as the web build emits it */
  await cp(join(rootDir, 'puppet.html'), join(dest, 'index.html'));
  /* the page's own relative paths: ./assets/* and ./vendor/* */
  await cp(join(rootDir, 'assets'), join(dest, 'assets'), { recursive: true });
  await cp(join(rootDir, 'vendor'), join(dest, 'vendor'), { recursive: true });
  const walk = async (dir) => {
    let bytes = 0, files = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { const r = await walk(p); bytes += r.bytes; files += r.files; }
      else { bytes += (await stat(p)).size; files++; }
    }
    return { bytes, files };
  };
  const t = await walk(dest);
  say(`staged ${t.files} asset files (${(t.bytes / 1048576).toFixed(1)} MB: page, MediaPipe runtime, WASM, face model)`);
  await verifyBundle(dest);
}

/* Every relative path the page mentions has to exist in the APK: the app has
   no INTERNET permission, so a missing file is not a 404, it is a feature
   that silently never loads on the phone.                              */
async function verifyBundle(dest) {
  const html = await readFile(join(dest, 'index.html'), 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/(?:\.\/)?((?:assets|vendor)\/[A-Za-z0-9._\/-]*[A-Za-z0-9_-])/g)) {
    refs.add(m[1]);
  }
  const missing = [];
  for (const r of refs) {
    try { await stat(join(dest, r)); } catch { missing.push(r); }
  }
  if (missing.length) {
    throw new Error('the page references files that are not in the APK: ' + missing.join(', '));
  }
  say(`bundle check: ${refs.size} page references resolve inside the APK`);
}

/* ---- build + sign -------------------------------------------------- */
async function main() {
  const java = await findJava();
  say('java: ' + java.java);
  const jars = await ensureJars();
  if (!argv.includes('--no-stage')) {
    say('generating puppet.html');
    run(process.execPath, [join(rootDir, 'tools/build.mjs')], { cwd: rootDir });
    await stageAssets();
  }
  await mkdir(outDir, { recursive: true });

  /* apktool: aapt2 for resources, smali -> classes.dex */
  const unsigned = join(outDir, '.unsigned.apk');
  say('building resources + classes.dex (apktool)');
  const buildOut = run(java.java, ['-jar', jars.apktool, 'b', androidDir, '-o', unsigned]);
  if (process.env.APK_VERBOSE) process.stdout.write(buildOut);

  const ks = await ensureKeystore(java);
  const signed = join(outDir, APK_NAME);
  await rm(signed, { force: true });
  say('signing (apksigner, v1+v2+v3)');
  run(java.java, ['-jar', jars.apksigner, 'sign',
    '--ks', ks, '--ks-pass', 'pass:facepuppet', '--key-pass', 'pass:facepuppet',
    '--min-sdk-version', '24',
    '--out', signed, unsigned]);
  await rm(unsigned, { force: true });

  const verify = run(java.java, ['-jar', jars.apksigner, 'verify', '--verbose', signed]);
  const schemes = verify.split('\n').filter(l => /^Verified using/.test(l)).map(l => l.trim());
  const size = (await stat(signed)).size;
  say(`APK: ${signed}`);
  say(`${(size / 1048576).toFixed(1)} MB · ${schemes.filter(s => s.endsWith('true')).length} signature schemes verified`);
  for (const s of schemes) say('   ' + s);
}

main().catch((e) => { console.error('\nAPK build failed:\n' + e.message); process.exit(1); });
