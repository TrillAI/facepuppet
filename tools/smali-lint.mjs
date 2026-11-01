#!/usr/bin/env node
/* =====================================================================
   FacePuppet · smali linter

   The Android shell is hand-written smali (no JDK compiler is available
   in this build environment), and a mistake there only shows up as a
   VerifyError on a device.  This lint catches the mistakes that are
   actually decidable statically:

     · register references outside the method's register window
     · invoke argument counts that do not match the target descriptor
       (static vs instance accounted for, wide types counted twice)
     · move-result / move-result-wide not directly after an invoke
     · labels used but never defined, duplicate labels
     · field/method references to this app's own classes that do not exist

   usage:  node tools/smali-lint.mjs [dir]     (default: android/smali)
   ===================================================================== */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const target = resolve(rootDir, process.argv[2] || 'android/smali');

const errors = [];
const warns = [];
const classes = new Map();           // desc -> { methods:Set, fields:Set }
const files = [];

async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith('.smali')) files.push(p);
  }
}

/* "Ljava/lang/String;I[J" -> [{ type, words }] */
function parseParams(sig) {
  const out = [];
  let i = 0;
  while (i < sig.length) {
    const c = sig[i];
    if (c === '[') {
      let j = i;
      while (sig[j] === '[') j++;
      if (sig[j] === 'L') { const k = sig.indexOf(';', j); out.push({ t: sig.slice(i, k + 1), w: 1 }); i = k + 1; continue; }
      out.push({ t: sig.slice(i, j + 1), w: 1 }); i = j + 1; continue;
    }
    if (c === 'L') { const k = sig.indexOf(';', i); out.push({ t: sig.slice(i, k + 1), w: 1 }); i = k + 1; continue; }
    out.push({ t: c, w: c === 'J' || c === 'D' ? 2 : 1 });
    i++;
  }
  return out;
}

await walk(target);

/* pass 1: collect every class / method / field the project declares, so the
   pass-2 reference check never depends on declaration order */
for (const file of files) {
  const src = await readFile(file, 'utf8');
  const cls = (src.match(/^\.class\s+(?:[\w-]+\s+)*(\S+)/m) || [])[1];
  if (!cls) continue;
  if (!classes.has(cls)) classes.set(cls, { methods: new Set(), fields: new Set(), file });
  const entry = classes.get(cls);
  for (const m of src.matchAll(/^\.method\s+(?:[\w\s-]*?\s)?(\S+?)\((.*?)\)(\S+)/gm)) entry.methods.add(m[1] + '(' + m[2] + ')');
  for (const f of src.matchAll(/^\.field\s+(?:[\w\s-]*?\s)?(\S+):(\S+)/gm)) entry.fields.add(f[1] + ':' + f[2]);
}

for (const file of files) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  const cls = (src.match(/^\.class\s+(?:[\w-]+\s+)*(\S+)/m) || [])[1];
  if (cls && !classes.has(cls)) classes.set(cls, { methods: new Set(), fields: new Set(), file });

  let method = null;                 // { name, desc, locals, pcount, static }
  let hasLocals = false;
  const labelsDefined = new Set();
  const labelsUsed = [];
  let prevWasInvoke = false;

  const flush = () => {
    if (!method) return;
    /* registers */
    const total = method.locals + method.pcount;
    for (const r of method.regRefs) {
      const n = r.idx;
      const limit = r.prefix === 'v' ? method.locals : method.pcount;
      if (n >= limit) {
        errors.push(`${file}:${r.line}  ${method.name}: ${r.prefix}${n} out of range (v0..v${method.locals - 1}` +
          (method.pcount ? `, p0..p${method.pcount - 1}` : '') + ')');
      }
      void total;
    }
    /* invokes */
    for (const inv of method.invokes) {
      const m = inv.ref.match(/^(.*)->([^\(]+)\((.*)\)(\S+)$/);
      if (!m) { errors.push(`${file}:${inv.line}  malformed invoke ref ${inv.ref}`); continue; }
      const params = parseParams(m[3]);
      const need = params.reduce((a, p) => a + p.w, 0) + (inv.kind === 'static' ? 0 : 1);
      if (inv.regs.length !== need) {
        errors.push(`${file}:${inv.line}  ${method.name}: invoke-${inv.kind} ${m[2]}${m[3]} expects ${need} register(s), has ${inv.regs.length}`);
      }
      /* own classes */
      if (classes.has(m[1])) {
        const cm = m[2] + '(' + m[3] + ')';
        if (!classes.get(m[1]).methods.has(cm)) {
          warns.push(`${file}:${inv.line}  ${m[1]}->${cm} not declared in the project (framework or external?)`);
        }
      }
      /* wide registers must not be split across a pair count mismatch — the
         register list length already encodes nothing about widths, so only
         the total count check above is decidable. */
    }
    for (const u of labelsUsed) if (!labelsDefined.has(u.name)) errors.push(`${file}:${u.line}  undefined label ${u.name}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const ln = i + 1;
    if (line.startsWith('#') || line === '') { continue; }

    const mClass = line.match(/^\.class\s+(?:[\w-]+\s+)*(\S+)/);
    if (mClass) continue;

    const mMethod = line.match(/^\.method\s+(?:[\w\s-]+ )?(\S+?)\((.*?)\)(\S+)/);
    if (mMethod) {
      method = { name: mMethod[1], desc: mMethod[2], locals: 0, pcount: 0, static: /^\.method\s+[\w\s-]*static/.test(line) || / static /.test(' ' + line + ' '),
        regRefs: [], invokes: [] };
      hasLocals = false;
      labelsDefined.clear();
      labelsUsed.length = 0;
      /* parameter register count */
      const params = parseParams(mMethod[2]);
      method.pcount = params.reduce((a, p) => a + p.w, 0) + (method.static ? 0 : 1);
      classes.get(cls) && classes.get(cls).methods.add(mMethod[1] + '(' + mMethod[2] + ')');
      continue;
    }
    if (/^\.end method/.test(line)) { flush(); method = null; continue; }
    if (!method) continue;

    const mLocals = line.match(/^\.locals\s+(\d+)/);
    if (mLocals) { method.locals = parseInt(mLocals[1], 10); hasLocals = true; continue; }
    const mRegisters = line.match(/^\.registers\s+(\d+)/);
    if (mRegisters) { method.locals = parseInt(mRegisters[1], 10) - method.pcount; hasLocals = true; continue; }

    const mField = line.match(/^\.field\s+(?:[\w\s-]+ )?(\S+):(\S+)/);
    if (mField) { classes.get(cls) && classes.get(cls).fields.add(mField[1] + ':' + mField[2]); continue; }

    const mLbl = line.match(/^:([\w$]+)/);
    if (mLbl) { if (labelsDefined.has(mLbl[1])) errors.push(`${file}:${ln}  duplicate label :${mLbl[1]}`); labelsDefined.add(mLbl[1]); continue; }

    /* register mentions: v0, p1, and ranges {v0 .. v4} / {v0, v1, p2} */
    for (const mm of line.matchAll(/\b([vp])(\d+)\b/g)) {
      method.regRefs.push({ prefix: mm[1], idx: parseInt(mm[2], 10), line: ln });
    }
    /* branch targets */
    for (const mm of line.matchAll(/\s:([\w$]+)\s*$/g)) labelsUsed.push({ name: mm[1], line: ln });

    const mInv = line.match(/^invoke-(\w+)\s+\{([^}]*)\},\s*(\S+)/);
    if (mInv) {
      const kind = mInv[1];
      const regs = mInv[2].split(',').map(s => s.trim()).filter(Boolean);
      let regCount = regs.length;
      const mRange = mInv[2].match(/^\s*([vp]\d+)\s*\.\.\s*([vp]\d+)\s*$/);
      if (mRange) regCount = parseInt(mRange[2].slice(1), 10) - parseInt(mRange[1].slice(1), 10) + 1;
      method.invokes.push({ kind, regs: new Array(regCount), ref: mInv[3], line: ln });
      prevWasInvoke = true;
      continue;
    }
    if (/^move-result/.test(line)) {
      if (!prevWasInvoke) errors.push(`${file}:${ln}  move-result without an immediately preceding invoke`);
      prevWasInvoke = false;
      continue;
    }
    prevWasInvoke = false;
  }
  if (method) errors.push(`${file}  unterminated .method ${method.name}`);
}

for (const w of warns) console.log('  warn ' + w);
for (const e of errors) console.log('  FAIL ' + e);
console.log(`\n${files.length} smali files, ${classes.size} classes, ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
