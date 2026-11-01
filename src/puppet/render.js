/* =====================================================================
   FaceMirror · puppet renderer
   The still photo becomes a closed 3D shell (face + three hair rings +
   a pinned frame).  Every frame the shell is rotated about the head
   centre, weak-perspective projected and painted far -> near as
   per-triangle affines.

   Anti-artifact design goals (not a guarantee of photorealistic turns)
     · stable far-to-near depth-key sorting and back-face handling reduce
       paint-order smearing
     · culled / far-side triangles re-sample a mirrored source patch; this
       mitigates silhouette collapse but cannot reconstruct unseen details
     · every clip goes through FM.polyOK and every wide fill is clipped
       to a computed bounding box -> a degenerate clip can never flash
       the whole canvas
     · no getImageData in the frame loop; blur filters are local to small feature passes
     · the shell is composed on an offscreen layer that is blitted once,
       so a frame is never shown half-finished
     · every feature pass runs every frame, gated by smooth envelopes
   ===================================================================== */
(function (root) {
  'use strict';
  const FM = root.FM, E = root.FMEngine;
  const { clamp, clamp01, smoothstep, envelope, polyOK, bounds, v3, matFromQuat } = FM;
  const EAR_TRI_WEIGHT = 0.12;
  /* Extra parallax for pinna pixels: the ear sticks out of the skull, so on
     a turn it swings a little further than the cheek it sits on.  Kept
     small and weight-proportional so no triangle can fold.               */
  const EAR_PARALLAX = 0.22;
  const ID3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  function makeCanvas(w, h) {
    const c = root.document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function noiseTexture(size) {
    const c = makeCanvas(size, size), g = c.getContext('2d');
    const d = g.createImageData(size, size);
    let s = 99;
    for (let i = 0; i < d.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 128 + ((s >> 16) & 63) - 32;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  /* ---------------------------------------------------------- session */
  function createSession() {
    return {
      head: null, mesh: null, src: null, canvas: null, layer: null, lctx: null,
      W: 0, H: 0, ready: false,
      S2: null, DST: null, BASE: null, depth: null, normals: null, normalsFace: null,
      earW: null, earOff: null,
      passes: null, proj: null, proj0: null, arches: null,
      cache: { noise: noiseTexture(96), iris: [null, null], sclera: ['235,230,225', '235,230,225'], plate: null, lum: 0.7, warm: 0.5 },
      hair: { x: 0, y: 0, vx: 0, vy: 0 },
      lidSkin: [null, null], jaw: 0, openEnv: 0, earShade: 0,
      frames: 0, stats: { tris: 0, culled: 0, earBand: 0, earFaded: 0, earDetailSkipped: 0 }, lastDebug: null
    };
  }

  const readAt = (S, x, y, n) => {
    const x0 = clamp(Math.round(x) - (n >> 1), 0, Math.max(0, S.W - n));
    const y0 = clamp(Math.round(y) - (n >> 1), 0, Math.max(0, S.H - n));
    /* one cached full-frame readback per session keeps the frame loop and
       the build-time colour probes free of getImageData traffic          */
    const pix = S.cache && S.cache.srcPix;
    if (pix && pix.data && pix.width > 1) {
      const d = pix.data, pw = pix.width, ph = pix.height;
      const px0 = clamp(x0, 0, Math.max(0, pw - n)), py0 = clamp(y0, 0, Math.max(0, ph - n));
      let r = 0, gg = 0, b = 0, c = 0;
      for (let yy = py0; yy < py0 + n; yy++) {
        for (let xx = px0; xx < px0 + n; xx++) {
          const i = (yy * pw + xx) * 4;
          r += d[i]; gg += d[i + 1]; b += d[i + 2]; c++;
        }
      }
      return c ? [r / c, gg / c, b / c] : [120, 90, 70];
    }
    try {
      const d = S.src.getContext('2d').getImageData(x0, y0, n, n).data;
      let r = 0, gg = 0, b = 0, c = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; c++; }
      return [r / c, gg / c, b / c];
    } catch (e) { return [120, 90, 70]; }
  };

  function prepIris(S) {
    const { head } = S;
    let lum = 0, warm = 0, n = 0;
    for (const i of [205, 425, 50, 280, 36, 266, 116, 345, 129, 358]) {
      const p = head.P[i], c = readAt(S, p[0], p[1], 5);
      lum += (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
      warm += (c[0] - c[2]) / 255;
      n++;
    }
    S.cache.lum = n ? clamp(lum / n, 0.1, 1) : 0.7;
    S.cache.warm = n ? clamp(warm / n * 2 + 0.5, 0, 1) : 0.5;
    for (let e = 0; e < 2; e++) {
      const which = e ? 'R' : 'L';
      const I = E.IRIS[which], ring = I.ring, c = head.P[I.c];
      let rs = 0;
      for (const k of ring) rs += Math.hypot(head.P[k][0] - c[0], head.P[k][1] - c[1]);
      rs = Math.max(2.5, rs / ring.length);
      const R = Math.ceil(rs * 1.35);
      const s1 = readAt(S, c[0] + (head.P[E.LIDS[which].ic][0] - c[0]) * .6, c[1] + (head.P[E.LIDS[which].ic][1] - c[1]) * .6, 5);
      const s2 = readAt(S, c[0] + (head.P[E.LIDS[which].oc][0] - c[0]) * .6, c[1] + (head.P[E.LIDS[which].oc][1] - c[1]) * .6, 5);
      const brighter = (s1[0] + s1[1] + s1[2] > s2[0] + s2[1] + s2[2]) ? s1 : s2;
      S.cache.sclera[e] = brighter.map(v => Math.round(clamp(v * 1.04 * (0.6 + S.cache.lum * 0.6), 0, 255))).join(',');
      const patch = makeCanvas(R * 2, R * 2), g = patch.getContext('2d');
      const ir = [0, 1, 2].reduce((acc, k) => {
        const q = readAt(S, c[0] + (k === 0 ? -rs * .6 : k === 1 ? rs * .6 : 0), c[1] + (k === 2 ? rs * .6 : 0), 5);
        return [acc[0] + q[0] / 3, acc[1] + q[1] / 3, acc[2] + q[2] / 3];
      }, [0, 0, 0]);
      const gr = g.createRadialGradient(R, R, 0, R, R, rs);
      gr.addColorStop(0, 'rgb(14,10,8)'); gr.addColorStop(.3, 'rgb(14,10,8)');
      gr.addColorStop(.42, `rgb(${ir.map(Math.round)})`);
      gr.addColorStop(1, `rgb(${ir.map(v => Math.round(v * .6))})`);
      g.fillStyle = gr; g.beginPath(); g.arc(R, R, rs, 0, 7); g.fill();
      g.save();
      g.beginPath();
      E.EYE_RING[which].forEach((i, k) => {
        const p = head.P[i], x = p[0] - c[0] + R, y = p[1] - c[1] + R;
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath(); g.clip();
      try { g.drawImage(S.src, c[0] - R, c[1] - R, R * 2, R * 2, 0, 0, R * 2, R * 2); } catch (e) {}
      g.restore();
      g.globalCompositeOperation = 'destination-in';
      const m = g.createRadialGradient(R, R, rs * .9, R, R, rs * 1.24);
      m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = m; g.fillRect(0, 0, R * 2, R * 2);
      S.cache.iris[e] = { cv: patch, R, r: rs };
    }
  }

  /* plate: the photo with the silhouette band radially edge-extended, so
     pixels revealed by a turn continue hair / skin instead of showing a
     stale frontal cheek.  Built once per image.                       */
  function buildPlate(S) {
    const { W, H, head } = S;
    const plate = makeCanvas(W, H), g = plate.getContext('2d');
    g.drawImage(S.src, 0, 0);
    const cx = head.ctr[0], cy = head.ctr[1];
    const R = Math.max(head.fw, head.fh) * 0.56;
    const N = 56;
    g.save();
    g.filter = 'blur(3px)';
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      for (const k of [0.99, 1.09, 1.19, 1.29]) {
        const inx = cx + dx * R * k, iny = cy + dy * R * k;
        const sz = 22;
        const x0 = clamp(inx - dx * 8 - sz / 2, 0, W - sz), y0 = clamp(iny - dy * 8 - sz / 2, 0, H - sz);
        g.globalAlpha = 0.34;
        try { g.drawImage(S.src, x0, y0, sz, sz, x0 + dx * 9, y0 + dy * 9, sz, sz); } catch (e) {}
      }
    }
    g.restore();
    S.cache.plate = plate;
    /* Soft twin of the plate: mirrored back-face samples come from here so
       the unseen side reads as out-of-focus skin/hair instead of sharp
       wrong features tessellated into facets.                            */
    const qw = Math.max(8, Math.round(W / 5)), qh = Math.max(8, Math.round(H / 5));
    const small = makeCanvas(qw, qh);
    const sg = small.getContext('2d');
    sg.drawImage(plate, 0, 0, qw, qh);
    const soft = makeCanvas(W, H);
    const fg = soft.getContext('2d');
    fg.imageSmoothingEnabled = true;
    fg.imageSmoothingQuality = 'high';
    fg.drawImage(small, 0, 0, qw, qh, 0, 0, W, H);
    S.cache.plateSoft = soft;
    const bw = Math.max(8, Math.round(W / 8)), bh = Math.max(8, Math.round(H / 8));
    const bl = makeCanvas(bw, bh);
    bl.getContext('2d').drawImage(S.src, 0, 0, bw, bh);
    S.cache.blurSmall = bl;
  }

  /* ------------------------------------------------------ sessionInit */
  function sessionInit(S, spec) {
    S.src = spec.source;
    /* ONE full-frame readback feeds every texture probe for this head; no
       getImageData is allowed inside the per-frame render loop. */
    if (!S.cache.srcPix && S.src && S.src.getContext) {
      const sw = S.src.width | 0, sh = S.src.height | 0;
      try { S.cache.srcPix = sw > 1 && sh > 1 ? S.src.getContext('2d').getImageData(0, 0, sw, sh) : null; } catch (e) { S.cache.srcPix = null; }
    }
    S.canvas = spec.canvas;
    S.head = spec.head;
    S.mesh = spec.mesh;
    S.W = S.src.width; S.H = S.src.height;
    if (S.canvas.width !== S.W || S.canvas.height !== S.H) { S.canvas.width = S.W; S.canvas.height = S.H; }
    S.layer = makeCanvas(S.W, S.H);
    S.lctx = S.layer.getContext('2d');
    const n = spec.mesh.n;
    S.S2 = new Float32Array(n * 2);
    S.DST = new Float32Array(n * 2);
    S.BASE = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = spec.mesh.P[i];
      S.S2[i * 2] = p[0]; S.S2[i * 2 + 1] = p[1];
      S.BASE[i * 3] = p[0]; S.BASE[i * 3 + 1] = p[1]; S.BASE[i * 3 + 2] = p[2];
    }
    S.depth = new Float32Array(n);
    S.earW = spec.mesh.earW && spec.mesh.earW.length === n ? spec.mesh.earW : new Float32Array(n);
    S.earOff = new Float32Array(n * 2);   // per-frame ear swing (screen px)
    const mkNormals = (list) => {
      const out = new Float32Array(list.length);
      for (let t = 0; t < list.length; t += 3) {
        const a = list[t], b = list[t + 1], c = list[t + 2];
        const pa = spec.mesh.P[a], pb = spec.mesh.P[b], pc = spec.mesh.P[c];
        let nr = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
        const l = v3.len(nr) || 1;
        nr = [nr[0] / l, nr[1] / l, nr[2] / l];
        const area2 = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
        if (area2 < 0) nr = [-nr[0], -nr[1], -nr[2]];
        out[t] = nr[0]; out[t + 1] = nr[1]; out[t + 2] = nr[2];
      }
      return out;
    };
    S.normals = mkNormals(spec.mesh.base);
    S.normalsFace = mkNormals(spec.mesh.face);
    const mkPass = (list, normals, o) => {
      /* per-triangle ear factor (mean of its vertices): ear triangles
         follow different sampling rules in drawShell (no mirroring) */
      const earF = new Float32Array(list.length / 3);
      for (let t = 0; t < earF.length; t++) {
        earF[t] = (S.earW[list[t * 3]] + S.earW[list[t * 3 + 1]] + S.earW[list[t * 3 + 2]]) / 3;
      }
      return {
        list, normals, n: list.length / 3, earF,
        order: new Int32Array(list.length / 3),
        triBias: (() => {
          const m = list.length / 3, b = new Float32Array(m);
          for (let t = 0; t < m; t++) {
            let k = 0;
            for (let v = 0; v < 3; v++) if (list[t * 3 + v] >= 478) k++;
            b[t] = k === 3 ? -120 : k > 0 ? -60 : 0;
          }
          return b;
        })(),
        dkey: new Float32Array(list.length / 3),
        tmp: new Int32Array(list.length / 3),
        mergeFallbacks: 0, initialized: false,
        pad: o.pad, cull: o.cull, mirror: o.mirror !== false, detail: !!o.detail
      };
    };
    const mkColors = (list) => {
      const out = new Array(list.length / 3);
      for (let t = 0; t < out.length; t++) {
        const a = spec.mesh.P[list[t * 3]], b = spec.mesh.P[list[t * 3 + 1]], c = spec.mesh.P[list[t * 3 + 2]];
        const g = readAt(S, (a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, 3);
        out[t] = `rgb(${g[0] | 0},${g[1] | 0},${g[2] | 0})`;
      }
      return out;
    };
    /* The dense face pass must not pad: its pad ring would paint over the
       base pass with a second, slightly different affine and outline every
       tessellation triangle (a low-poly "facet" look).  Shared edges get
       anti-aliased against the base pass, which samples nearly the same
       source pixels, so hairlines stay invisible.                      */
    S.triA = mkPass(spec.mesh.base, S.normals, { pad: 0.40, cull: -0.02, mirror: true });
    S.triB = mkPass(spec.mesh.face, S.normalsFace, { pad: 0.0, cull: -0.05, mirror: true, detail: true });
    S.triA.colStr = mkColors(spec.mesh.base);
    S.triB.colStr = mkColors(spec.mesh.face);
    /* per-vertex source colours: folded triangles get Gouraud-style
       gradient fills so compressed skin shades smoothly instead of
       showing constant-colour facets                                  */
    S.colV = spec.mesh.P.map(q => readAt(S, q[0], q[1], 2));
    S.lipMask = new Uint8Array(spec.mesh.P.length);
    for (const i of [...E.LIPS_O, ...E.LIPS_I, ...E.NOSE, 13, 14, 17, 0]) S.lipMask[i] = 1;
    S.mid = spec.head.mid.slice();
    S.axis = E.tmjAxis(spec.head);
    S.arches = buildArches();
    prepIris(S);
    buildPlate(S);
    S.ready = true;
    return S;
  }
  /* ------------------------------------------------------------ deform */
  function deform(S, st) {
    const { head, mesh } = S;
    const n = mesh.n;
    const delta = st.deltaCanonical;
    const jawGain = clamp01(st.jawMeshGain === undefined ? 1 : st.jawMeshGain);
    const C = new Array(478);
    for (let i = 0; i < 478; i++) {
      const p = head.P[i];
      C[i] = [p[0], p[1], p[2]];
      if (delta) { C[i][0] += delta[i * 3]; C[i][1] += delta[i * 3 + 1]; C[i][2] += delta[i * 3 + 2]; }
    }
    const gapNow = Math.hypot(C[13][0] - C[14][0], C[13][1] - C[14][1]);
    const expressionOpen = clamp01(st.jawOpen || 0);
    const want = clamp01(Math.max(gapNow / (head.fh * 0.17), expressionOpen)) * 0.40;
    S.jaw = FM.slew(S.jaw, want, st.dt || 1 / 60, 3.2, 3.6);
    const jawAng = S.jaw * jawGain;
    /* the signed, gain-applied angle every bone-driven pass shares (teeth,
       drag solve, diagnostics): positive = mouth opening. */
    S.jawAng = jawAng;
    /* one shared mandible rotation, applied with the *smoothed* bone
       weights so the skin over the jaw boundary stretches instead of
       tearing; the hair-shell points hang off the same weights         */
    const jawR = jawAng > 1e-4 ? FM.m3.fromAxisAngle(S.axis.dir, jawAng) : null;
    const jawW = mesh.jawW;
    if (jawR) {
      for (let i = 0; i < 478; i++) {
        const wJ = jawW ? jawW[i] : E.jawWeight(i, head);
        if (wJ <= 0.001) continue;
        const p = C[i];
        const rel = [p[0] - S.axis.p[0], p[1] - S.axis.p[1], p[2] - S.axis.p[2]];
        const rot = FM.m3.mv(jawR, rel);
        p[0] += (S.axis.p[0] + rot[0] - p[0]) * wJ;
        p[1] += (S.axis.p[1] + rot[1] - p[1]) * wJ;
        p[2] += (S.axis.p[2] + rot[2] - p[2]) * wJ;
      }
    }
    /* hair spring: chases the head, lags, capped */
    const H = S.hair;
    const yaw = E.eulerYaw(st.q);
    /* hair counter-swings a little (lag spring); keep it modest — a large
       sway shears the hairline junction against the turning face        */
    const tgtX = -(st.ox || 0) - head.fw * 0.55 * Math.sin(yaw);
    const tgtY = -(st.oy || 0) - head.fh * 0.05 * head.P[10][2] / Math.max(1, head.fw) + Math.sin(st.t * 1.3) * head.fh * 0.004;
    H.vx = (H.vx + (tgtX - H.x) * 0.10) * 0.87;
    H.vy = (H.vy + (tgtY - H.y) * 0.10) * 0.87;
    H.x += H.vx; H.y += H.vy;
    const hg = st.hairGain === undefined ? 0.6 : st.hairGain;
    const hm = Math.hypot(H.x, H.y), cap = head.fh * 0.16;
    const hlx = (hm > cap ? H.x * cap / hm : H.x) * hg;
    const hly = (hm > cap ? H.y * cap / hm : H.y) * hg;
    /* rotation + weak perspective about the skull's true turn axis: the
       atlanto-axial joint sits at ear-canal depth, so the nose arcs across
       the frame while the far cheek compresses (real turn parallax).    */
    const q = st.q, R = matFromQuat(q);
    const f = st.focal * head.fw;
    const pivot = S.pivot || (S.pivot = E.skullPivot(head));
    const cx = pivot[0], cy = pivot[1];
    const ox = st.ox || 0, oy = st.oy || 0, sc = st.scale || 1;
    const zc = st.depthGain || 0;
    const projWith = (Rm) => (p) => {
      const rx = p[0] - cx, ry = p[1] - cy, rz = p[2] - pivot[2];
      const mx = Rm[0] * rx + Rm[1] * ry + Rm[2] * rz;
      const my = Rm[3] * rx + Rm[4] * ry + Rm[5] * rz;
      const mz = Rm[6] * rx + Rm[7] * ry + Rm[8] * rz;
      let d = f - mz * sc;
      if (Math.abs(d) < f * 0.25) d = d < 0 ? -f * 0.25 : f * 0.25;
      const k = f / d;
      return [cx + mx * sc * k + ox, cy + my * sc * k + oy, mz];
    };
    const proj = projWith(R);
    /* identity-pose projection: the rest pose must land exactly on the
       source pixels, and every rigid displacement is measured against it */
    const proj0 = projWith(ID3);
    S.proj = proj;
    S.proj0 = proj0;
    const body = st.bodyAt || null;
    const ringOf = mesh.ringOf;
    for (let i = 0; i < n; i++) {
      S.earOff[i * 2] = 0; S.earOff[i * 2 + 1] = 0;
      const w = mesh.w[i], sx = S.S2[i * 2], sy = S.S2[i * 2 + 1];
      if (w <= 0) {
        let dx = 0, dy = 0;
        if (body && mesh.kind[i] === 2) { const b = body(sx, sy); if (b) { dx = b[0]; dy = b[1]; } }
        S.DST[i * 2] = sx + dx; S.DST[i * 2 + 1] = sy + dy; S.depth[i] = S.BASE[i * 3 + 2];
        continue;
      }
      const isFace = i < 478;
      /* hair-shell weight fades to zero below the jaw: the neck and collar
         do not swing with the turn, and the ring->skirt junction would
         otherwise stretch into spikes                               */
      let wEff = w;
      if (!isFace && w > 0) {
        const y0 = head.P[152][1] + head.fh * 0.12;
        wEff = w * (1 - smoothstep(y0, y0 + head.fh * 0.22, sy));
      }
      /* Animated canonical position.  Hair-shell points inherit the jaw
         rotation and the expression delta of the contour point they were
         extruded from, weighted by their shell factor — without this the
         boundary triangles between chin and hair ring fold open as soon
         as the mouth moves.                                              */
      let cur = null;
      if (isFace) {
        cur = C[i];
      }
      /* shell vertices keep only 30% of their depth about the pivot (both
         in the posed and the rest projection): a flat photo banner swung
         rigidly in z makes the back rings travel opposite the face and
         tear radial spikes off the silhouette                          */
      /* Shell vertices inherit the *displacement* of the contour landmark
         they were extruded from (scaled by their shell weight) instead of
         re-rotating their extruded position: a rigid swing of the flat
         photo banner makes back rings travel opposite the face and tears
         radial spikes off every silhouette junction.                   */
      let dx = 0, dy = 0, depth1 = S.BASE[i * 3 + 2];
      if (!isFace) {
        /* shell displacement (anchor inheritance) is applied in a second
           pass after limits(), so rings stay welded to the final face   */
      } else {
        const bz = S.BASE[i * 3 + 2] * (1 + zc);
        const p1 = proj([cur[0], cur[1], cur[2] * (1 + zc)]);
        const p0 = proj0([S.BASE[i * 3], S.BASE[i * 3 + 1], bz]);
        dx = (p1[0] - p0[0]) * wEff; dy = (p1[1] - p0[1]) * wEff;
        /* ---- pinna parallax -------------------------------------------
           Ear-band pixels already rotate with the head; the pinna protrudes
           laterally, so it gets an extra swing proportional to its ear
           weight — strongly tucking on the far side (the ear folds behind
           the jaw) and slightly counter-swinging on the near side.     */
        const ew = S.earW[i];
        if (ew > 0.003) {
          const pr = proj([S.BASE[i * 3], S.BASE[i * 3 + 1], bz]);
          const farSide = (yaw >= 0) !== (S.BASE[i * 3] < head.mid[0]);
          const g = clamp01(ew) * EAR_PARALLAX * wEff;
          /* genuine tuck: the far pinna slides behind the jaw while the near
             pinna swings toward the midline with less amplitude. Both scale
             with sin(yaw), which vanishes at the mirror threshold, so the
             far/near hand-off stays continuous (no step at yaw sign flip). */
          const toCtr = head.mid[0] > S.BASE[i * 3] ? 1 : -1;
          const tuck = toCtr * Math.abs(Math.sin(yaw)) * head.fw * 0.102 * clamp01(ew) * wEff * (farSide ? 1 : -0.6);
          const ex = (pr[0] - p0[0]) * g + tuck, ey = (pr[1] - p0[1]) * g;
          if (isFinite(ex) && isFinite(ey)) {
            dx += ex; dy += ey;
            S.earOff[i * 2] = ex; S.earOff[i * 2 + 1] = ey;
          }
          /* the pinna turns with the head at a fraction of the full screen
             swing; its depth key must use the same fraction or the ear
             outranks the cheek it attaches to in the painter sort      */
          const earTurn = Math.min(1, ew * 0.5);
          depth1 = p0[2] + (p1[2] - p0[2]) * earTurn;
        } else {
          depth1 = p1[2];
        }
      }
      if (mesh.kind[i] === 1 && hg > 0) {
        const info = ringOf[i - 478];
        const hw = info && info.ring < 3 ? 0.6 : 0;   /* uniform: per-ring sway shears the hair band */
        const top = clamp01((head.ctr[1] - sy) / head.fh + 0.75);
        dx += hlx * hw * top; dy += hly * hw * top;
      }
      S.DST[i * 2] = sx + dx;
      S.DST[i * 2 + 1] = sy + dy;
      S.depth[i] = depth1 * wEff + S.BASE[i * 3 + 2] * (1 - wEff) * 0.4;
    }
    if (st.limits !== false) {
      limits(head, C, (out) => {
        for (let i = 0; i < 478; i++) {
          const w = mesh.w[i];
          if (w <= 0) continue;
          const d = out[i];
          const p1 = proj([d[0], d[1], d[2] * (1 + zc)]);
          const p0 = proj([C[i][0], C[i][1], C[i][2] * (1 + zc)]);
          S.DST[i * 2] += (p1[0] - p0[0]) * w;
          S.DST[i * 2 + 1] += (p1[1] - p0[1]) * w;
        }
      });
    }
    /* ---- second pass: weld the hair shell to the finished face ---------
       Rings inherit the final displacement of the contour landmark they
       were extruded from (scaled by shell weight, faded at the neck), so
       every silhouette junction moves as one and never tears.          */
    for (let i = 478; i < n; i++) {
      const info = ringOf[i - 478];
      const c = info ? info.contour : -1;
      if (c < 0 || c >= 478) continue;
      const isSkirt = info.ring === 3;
      if (mesh.w[i] <= 0 && !isSkirt) continue;
      const y0 = head.P[152][1] + head.fh * 0.12;
      /* gentle per-ring falloff: a big weight step between shells shears
         the hair band into folded slivers as soon as the head turns; the
         collar banner keeps a quarter of the chin motion so the neck
         junction stretches in one smooth ladder instead of tearing    */
      const rs = [0.95, 0.80, 0.55, 0.30][info.ring];
      const wEff2 = rs * (isSkirt ? 1 : 1 - smoothstep(y0, y0 + head.fh * 0.22, S.S2[i * 2 + 1]));
      if (wEff2 <= 0.001) continue;
      S.DST[i * 2] += (S.DST[c * 2] - S.S2[c * 2]) * wEff2;
      S.DST[i * 2 + 1] += (S.DST[c * 2 + 1] - S.S2[c * 2 + 1]) * wEff2;
      S.earOff[i * 2] = (S.earOff[c * 2] || 0) * wEff2;
      S.earOff[i * 2 + 1] = (S.earOff[c * 2 + 1] || 0) * wEff2;
      S.depth[i] = S.BASE[i * 3 + 2] + (S.depth[c] - S.BASE[c * 3 + 2]) * wEff2 * 0.4;
    }
    return C;
  }
  /* lip / lid collision: smooth projection, never a hard snap */
  function limits(head, C, apply) {
    const groups = [
      [E.LIDS.L.up, E.LIDS.L.lo], [E.LIDS.R.up, E.LIDS.R.lo],
      [E.UP_LIP, E.LO_LIP]
    ];
    const out = C.map(p => p.slice());
    let touched = false;
    for (const [ups, los] of groups) {
      for (let k = 0; k < Math.min(ups.length, los.length); k++) {
        const u = out[ups[k]], l = out[los[k]];
        const pen = (u[1] + 0.4) - l[1];
        if (pen > 0) {
          const corr = Math.min(pen * 0.85, head.fh * 0.06);
          out[ups[k]] = [u[0], u[1] - corr, u[2]];
          out[los[k]] = [l[0], l[1] + corr * 0.9, l[2]];
          touched = true;
        }
      }
    }
    if (touched) apply(out);
  }

  /* ----------------------------------------------------- triangle pass */
  function drawShell(S, ctx, st, pass, opts) {
    const o = opts || {};
    const DST = S.DST, S2 = S.S2, W = S.W, H = S.H;
    const p = S.proj;
    /* Depth key + temporally coherent ordering.  Start from last frame's
       order (insertion sort is O(m) when the pose barely moved), but if the
       budget blows up during a fast turn, fall back to a stable merge sort.
       Bucket order alone is insufficient: a small within-bucket inversion
       is still enough to smear two overlapping face triangles.             */
    const list = pass.list, m = pass.n, dk = pass.dkey, order = pass.order;
    if (o.resetOrder || !pass.initialized) {
      for (let i = 0; i < m; i++) order[i] = i;
      pass.initialized = true;
    }
    const tmp = pass.tmp;
    tmp.set(order.subarray(0, m)); // backup: insertion sort can stop mid-shift
    for (let t = 0; t < m; t++) {
      const i = t * 3;
      const a = list[i], b = list[i + 1], c = list[i + 2];
      dk[t] = (S.depth[a] + S.depth[b] + S.depth[c]) / 3 + pass.triBias[t];
    }
    {
      let work = 0, exact = true;
      const budget = m * 8;
      for (let i = 1; i < m; i++) {
        const v = order[i];
        let j = i - 1;
        while (j >= 0 && dk[order[j]] > dk[v]) {
          order[j + 1] = order[j]; j--;
          if (++work > budget) { exact = false; break; }
        }
        if (!exact) break;
        order[j + 1] = v;
      }
      if (!exact) {
        pass.mergeFallbacks++;
        /* Stable bottom-up merge sort: exact mean-depth-key order, O(m log m),
           allocation-free via the pass-owned scratch array. Restore the
           pre-sort order first: ties then keep their frame-to-frame order. */
        order.set(tmp.subarray(0, m)); // recover the intact list after a partial insertion sort
        for (let width = 1; width < m; width <<= 1) {
          for (let left = 0; left < m; left += width << 1) {
            const mid = Math.min(left + width, m), right = Math.min(left + (width << 1), m);
            let i = left, j = mid, k = left;
            while (i < mid && j < right) tmp[k++] = dk[order[i]] <= dk[order[j]] ? order[i++] : order[j++];
            while (i < mid) tmp[k++] = order[i++];
            while (j < right) tmp[k++] = order[j++];
          }
          order.set(tmp.subarray(0, m));
        }
      }
    }
    const R = matFromQuat(st.q);
    const turnBlend = clamp01(Math.hypot(st.q[0], st.q[1], st.q[2]) / 0.12);
    const midX = S.mid[0];
    const pad = pass.pad * (o.padScale || 1);
    let drawn = 0, culled = 0, earBand = 0, earFaded = 0, earDetailSkipped = 0;
    for (let t = 0; t < m; t++) {
      const tri = order[t] * 3;
      const a = list[tri], b = list[tri + 1], c = list[tri + 2];
      const nz = R[6] * pass.normals[tri] + R[7] * pass.normals[tri + 1] + R[8] * pass.normals[tri + 2];
      const behind = nz < pass.cull;
      /* Ear triangles are never mirror-sampled: an ear is chiral, so a
         mirrored copy of the opposite pinna reads as a wrong-way ear
         stuck on the silhouette, and ear normals sit near nz == 0 at
         rest, so the binary mirror flip pops triangle-by-triangle
         exactly there.  They keep their own texture and, as the far
         ear turns away, fade into the (unmirrored) edge-extended
         plate while the ear swing tucks them behind the jaw.       */
      const earF = pass.earF ? pass.earF[order[t]] : 0;
      const isEar = earF > EAR_TRI_WEIGHT;
      const dbg = S.dbgBox; let dbgRec = null;
      if (dbg) {
        const x0d = Math.min(DST[a*2], DST[b*2], DST[c*2]), x1d = Math.max(DST[a*2], DST[b*2], DST[c*2]);
        const y0d = Math.min(DST[a*2+1], DST[b*2+1], DST[c*2+1]), y1d = Math.max(DST[a*2+1], DST[b*2+1], DST[c*2+1]);
        if (x1d > dbg[0] && x0d < dbg[2] && y1d > dbg[1] && y0d < dbg[3]) {
          dbgRec = { pass: pass.detail ? 'B' : 'A', t, a, b, c, why: 'drawn' };
          S.dbg.push(dbgRec);
        }
      }
      /* The dense face-detail pass is painted after the whole shell. Letting
         its ear triangles through would draw them over nearer hair/cheek
         triangles regardless of shell depth. The base pass owns this band:
         it sorts ear, face, and hair together and still provides the texture. */
      if (pass.detail && isEar && turnBlend > 0.12) { earDetailSkipped++; if (dbgRec) dbgRec.why = 'ear'; continue; }
      const ax = DST[a * 2], ay = DST[a * 2 + 1];
      const bx = DST[b * 2], by = DST[b * 2 + 1];
      const cx = DST[c * 2], cy = DST[c * 2 + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!isFinite(area) || Math.abs(area) < 0.10) { S.stats.skipTiny++; if (dbgRec) dbgRec.why = 'tiny'; continue; }
      /* Compression guard for the dense overlay: a screen sliver whose
         source triangle is big would paint a compressed decal of far-away
         texture (the classic "shard" look).  The coarser base pass below
         covers the region continuously, so skip instead of shard.      */
      if (pass.detail) {
        const sa = Math.abs((S2[b * 2] - S2[a * 2]) * (S2[c * 2 + 1] - S2[a * 2 + 1]) -
                            (S2[b * 2 + 1] - S2[a * 2 + 1]) * (S2[c * 2] - S2[a * 2]));
        if (sa > 4 && Math.abs(area) / sa < 0.35) { S.stats.skipComp++; if (dbgRec) dbgRec.why = 'comp'; continue; }
      }
      const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
      const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
      if (maxX < -3 || maxY < -3 || minX > W + 3 || minY > H + 3) continue;
      let s0x = S2[a * 2], s0y = S2[a * 2 + 1];
      let s1x = S2[b * 2], s1y = S2[b * 2 + 1];
      let s2x = S2[c * 2], s2y = S2[c * 2 + 1];
      /* Mirrored source approximation; swap the sample winding so the
         affine remains non-degenerate. This is not learned inpainting. */
      const applyMirror = () => {
        const m0 = 2 * midX - s0x;
        const m1x = 2 * midX - s1x, m1y = s1y;
        s1x = 2 * midX - s2x; s1y = s2y;
        s2x = m1x; s2y = m1y;
        s0x = m0;
      };
      const solve = () => {
        const d = (s1x - s0x) * (s2y - s0y) - (s1y - s0y) * (s2x - s0x);
        if (!isFinite(d) || Math.abs(d) < 1e-6) return null;
        const k = 1 / d;
        return {
          det: d,
          ma: ((bx - ax) * (s2y - s0y) - (by - ay) * (s2x - s0x)) * k,
          mb: ((by - ay) * (s1x - s0x) - (bx - ax) * (s1y - s0y)) * k,
          mc: ((cx - ax) * (s2y - s0y) - (cy - ay) * (s2x - s0x)) * k,
          md: ((cy - ay) * (s1x - s0x) - (cx - ax) * (s1y - s0y)) * k,
          me: ax - ((bx - ax) * (s2y - s0y) - (by - ay) * (s2x - s0x)) * k * s0x - ((cx - ax) * (s2y - s0y) - (cy - ay) * (s2x - s0x)) * k * s0y,
          mf: ay - ((by - ay) * (s1x - s0x) - (bx - ax) * (s1y - s0y)) * k * s0x - ((cy - ay) * (s1x - s0x) - (cx - ax) * (s1y - s0y)) * k * s0y
        };
      };
      let aff = solve();
      if (!aff) { S.stats.skipAff++; if (dbgRec) dbgRec.why = 'aff'; continue; }
      /* A triangle is a true back face only when it turned away AND its
         screen winding flipped.  A far-side triangle merely at a grazing
         angle keeps its winding: mirroring those sampled the opposite
         hairline onto the far cheek (shards on every turn).            */
      const folded0 = (aff.det < 0) !== (area < 0);
      let mirrored = folded0 && behind && pass.mirror && !isEar;
      if (mirrored) {
        applyMirror();
        const again = solve();
        if (again) aff = again; else mirrored = false;
      }
      /* Fold guard: a front-facing triangle whose screen winding disagrees
         with its source winding is inside-out and would paint a mirrored
         sliver.  Re-solve against the mirrored source instead.          */
      if (folded0 && !mirrored && pass.mirror && !isEar) {
        applyMirror();
        mirrored = true;
        const again = solve();
        if (again) aff = again;
      }
      const { ma, mb, mc, md, me, mf } = aff;
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
      ctx.save();
      ctx.beginPath();
      const V = [[ax, ay], [bx, by], [cx, cy]];
      for (let i = 0; i < 3; i++) {
        const vx = V[i][0] - gx, vy = V[i][1] - gy, l = Math.hypot(vx, vy) || 1;
        const X = V[i][0] + vx / l * pad, Y = V[i][1] + vy / l * pad;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      ctx.closePath();
      ctx.clip();
      const foldedNow = (aff.det < 0) !== (area < 0);
      if (foldedNow && !behind && !isEar && pass.colStr) {
        /* inside-out triangle: shade it from its own vertex colours, then
           bring back real skin grain with the mirrored sample at partial
           alpha — a flat fill reads as a facet, a full-alpha mirror as a
           shard; the blend reads as compressed skin                    */
        const ca = S.colV[a], cb = S.colV[b], cc = S.colV[c];
        const mx = (bx + cx) / 2, my = (by + cy) / 2;
        if (ca && cb && cc && Math.hypot(mx - ax, my - ay) > 0.75) {
          const g = ctx.createLinearGradient(ax, ay, mx, my);
          g.addColorStop(0, `rgb(${ca[0] | 0},${ca[1] | 0},${ca[2] | 0})`);
          g.addColorStop(1, `rgb(${(cb[0] + cc[0]) / 2 | 0},${(cb[1] + cc[1]) / 2 | 0},${(cb[2] + cc[2]) / 2 | 0})`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = pass.colStr[order[t]];
        }
        ctx.fill();
        const onLip = S.lipMask[a] || S.lipMask[b] || S.lipMask[c];
        if (!mirrored && !onLip) { applyMirror(); const again = solve(); if (again) { aff = again; mirrored = true; } }
        if (mirrored && !onLip) {
          const { ma: ma2, mb: mb2, mc: mc2, md: md2, me: me2, mf: mf2 } = aff;
          const x0 = clamp(Math.floor(Math.min(s0x, s1x, s2x)) - 1, 0, W);
          const y0 = clamp(Math.floor(Math.min(s0y, s1y, s2y)) - 1, 0, H);
          const x1 = clamp(Math.ceil(Math.max(s0x, s1x, s2x)) + 1, 0, W);
          const y1 = clamp(Math.ceil(Math.max(s0y, s1y, s2y)) + 1, 0, H);
          if (x1 > x0 && y1 > y0) {
            ctx.globalAlpha = 0.45;
            ctx.setTransform(ma2, mb2, mc2, md2, me2, mf2);
            try { ctx.drawImage(S.src, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); } catch (e) {}
            ctx.globalAlpha = 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
          }
        }
        ctx.restore();
        drawn++; if (isEar) earBand++; S.stats.flatFill++; if (dbgRec) dbgRec.why = 'flat';
        continue;
      }
      ctx.setTransform(ma, mb, mc, md, me, mf);
      const x0 = clamp(Math.floor(Math.min(s0x, s1x, s2x)) - 1, 0, W);
      const y0 = clamp(Math.floor(Math.min(s0y, s1y, s2y)) - 1, 0, H);
      const x1 = clamp(Math.ceil(Math.max(s0x, s1x, s2x)) + 1, 0, W);
      const y1 = clamp(Math.ceil(Math.max(s0y, s1y, s2y)) + 1, 0, H);
      const sw = x1 - x0, sh = y1 - y0;
      if (sw > 0 && sh > 0) {
        try { ctx.drawImage(mirrored && behind && !isEar ? (S.cache.plateSoft || S.cache.plate) : S.src, x0, y0, sw, sh, x0, y0, sw, sh); } catch (e) {}
        if (isEar && S.cache.plate) {
          /* far ear melts into the edge-extended plate as its normal
             turns away — a continuous fade in nz, no binary switch.
             source. A skinny tessellation triangle can still fold at a
             hard turn, so ramp the plate replacement with turn strength:
             this hides flipped pinna texture without fading fringe
             triangles in the untouched frontal pose.                 */
          const folded = (aff.det < 0) !== (area < 0);
          const fade = folded ? turnBlend : clamp01((-nz - 0.04) / 0.28) * clamp01(earF * 1.7);
          if (fade > 0.01) {
            ctx.globalAlpha = fade;
            try { ctx.drawImage(S.cache.plate, x0, y0, sw, sh, x0, y0, sw, sh); } catch (e) {}
            ctx.globalAlpha = 1;
            earFaded++;
          }
        }
      }
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawn++; if (behind) culled++; if (isEar) earBand++;
    }
    S.stats.tris += drawn; S.stats.culled = (S.stats.culled || 0) + culled;
    S.stats.earBand = (S.stats.earBand || 0) + earBand;
    S.stats.earFaded = (S.stats.earFaded || 0) + earFaded;
    S.stats.earDetailSkipped = (S.stats.earDetailSkipped || 0) + earDetailSkipped;
    return drawn;
  }

  /* ------------------------------------------------------- accessories */
  function drawEyelid(S, ctx, which, c, D) {
    if (c < 0.015) return;
    const d = E.LIDS[which];
    const p = D[d.ic], q = D[d.oc];
    const upP = d.up.map(i => D[i]), loP = d.lo.map(i => D[i]);
    const ew = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    const top = Math.min(...upP.map(v => v.y)), bot = Math.max(...loP.map(v => v.y));
    const eh = Math.max(bot - top, ew * 0.13);
    const u = upP[2], l = loP[2];
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const m = { x: u.x + (l.x - u.x) * c, y: u.y + (l.y - u.y) * c };
    const k = { x: m.x * 2 - mx, y: m.y * 2 - my };
    const ty = top - eh * 0.5, m0 = ew * 0.07;
    const x0 = Math.floor(Math.min(p.x, q.x) - m0 - 8), y0 = Math.floor(ty - 8);
    const W = Math.ceil(ew + m0 * 2 + 16), Hh = Math.ceil(bot - ty + 16);
    const sy = top - eh * 0.95;
    if (W < 6 || Hh < 6 || x0 < 0 || y0 < 0 || x0 + W > S.W || y0 + Hh > S.H || sy < 0) return;
    const slot = which === 'L' ? 0 : 1;
    let fc = S.lidSkin[slot];
    if (!fc || fc.width < W || fc.height < Hh) {
      fc = makeCanvas(Math.max(W, S.W), Math.max(Hh, S.H));
      S.lidSkin[slot] = fc;
    }
    const fx = fc.getContext('2d');
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.clearRect(0, 0, fc.width, fc.height);
    fx.save();
    fx.translate(-x0, -y0);
    fx.filter = 'blur(1.2px)';
    fx.beginPath();
    fx.moveTo(p.x, p.y);
    fx.quadraticCurveTo(k.x, k.y, q.x, q.y);
    fx.lineTo(q.x + (q.x > p.x ? m0 : -m0), ty);
    fx.lineTo(p.x + (q.x > p.x ? -m0 : m0), ty);
    fx.closePath();
    fx.fill();
    fx.filter = 'none';
    fx.globalCompositeOperation = 'source-in';
    const skin = S.layer;
    try { fx.drawImage(skin, x0, sy, W, eh * 0.85, x0, ty, W, Math.max(2, bot - ty + 6)); } catch (e) {}
    fx.globalCompositeOperation = 'source-over';
    fx.restore();
    ctx.save();
    ctx.globalAlpha = clamp01(c * 3);
    try { ctx.drawImage(fc, 0, 0, W, Hh, x0, y0, W, Hh); } catch (e) {}
    ctx.restore();
    ctx.save();
    const edge = () => {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(k.x, k.y, q.x, q.y);
    };
    ctx.lineCap = 'round';
    ctx.filter = 'blur(1.6px)';
    ctx.strokeStyle = 'rgba(58,30,26,.30)';
    ctx.lineWidth = Math.max(1.2, ew * 0.085);
    edge(); ctx.stroke();
    ctx.filter = 'none';
    ctx.strokeStyle = 'rgba(43,26,22,.85)';
    ctx.lineWidth = Math.max(1.1, ew * 0.032);
    edge(); ctx.stroke();
    ctx.restore();
  }

  function drawIris(S, ctx, e, D, gaze, gain, facing) {
    const I = S.cache.iris[e];
    if (!I) return;
    /* an eye turning away foreshortens; fade its repaint passes with it so
       a narrow far-eye aperture never shows a full-size iris disc      */
    const face = facing === undefined ? 1 : clamp01(facing);
    if (face <= 0.05) return;
    const which = e ? 'R' : 'L';
    const d = E.LIDS[which], ring = E.IRIS[which].ring;
    const pc = D[E.IRIS[which].c];
    const ex = D[d.oc].x - D[d.ic].x, ey = D[d.oc].y - D[d.ic].y;
    const ew = Math.hypot(ex, ey) || 1;
    let r = 0;
    for (const k of ring) r += Math.hypot(D[k].x - pc.x, D[k].y - pc.y);
    r = (r / ring.length) || I.r;
    const ax = ex / ew, ay = ey / ew;
    const off = [(gaze[0] * ax - gaze[1] * ay) * ew * gain, (gaze[0] * ay + gaze[1] * ax) * ew * gain];
    const X = pc.x + off[0], Y = pc.y + off[1];
    const RR = Math.max(1.2, I.R * (r / I.r));
    const poly = E.EYE_RING[which].map(i => D[i]);
    if (!polyOK(poly, 3)) return;
    const bb = bounds(poly);
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.clip();
    const a = clamp01(Math.hypot(off[0], off[1]) / (ew * 0.02)) * face;
    if (a > 0.01) {
      const grd = ctx.createRadialGradient(pc.x, pc.y, Math.max(1, r * 0.25), pc.x, pc.y, Math.max(2, r * 1.5));
      grd.addColorStop(0, `rgba(${S.cache.sclera[e]},${a})`);
      grd.addColorStop(1, `rgba(${S.cache.sclera[e]},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    }
    ctx.save();
    ctx.globalAlpha = face;
    try { ctx.drawImage(I.cv, X - RR, Y - RR, RR * 2, RR * 2); } catch (err) {}
    ctx.restore();
    const lg = ctx.createRadialGradient(X, Y, Math.max(1, r * 0.8), X, Y, Math.max(1.2, r * 1.08));
    lg.addColorStop(0, 'rgba(15,10,8,0)'); lg.addColorStop(1, 'rgba(15,10,8,.34)');
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.arc(X, Y, r * 1.1, 0, 7); ctx.fill();
    const sg = ctx.createLinearGradient(0, bb.y0, 0, bb.y0 + bb.h * 0.55);
    sg.addColorStop(0, 'rgba(28,14,10,.36)'); sg.addColorStop(1, 'rgba(28,14,10,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(bb.x0, bb.y0, bb.w, bb.h * 0.6);
    ctx.restore();
  }

  /* how directly an eye still faces the camera: projected corner distance
     over its rest distance — 1 frontal, -> 0 as the eye turns away      */
  function eyeFacing(S, D, e) {
    const which = e ? 'R' : 'L';
    const d = E.LIDS[which];
    const rest = Math.hypot(S.head.P[d.oc][0] - S.head.P[d.ic][0], S.head.P[d.oc][1] - S.head.P[d.ic][1]) || 1;
    const now = Math.hypot(D[d.oc].x - D[d.ic].x, D[d.oc].y - D[d.ic].y);
    /* horizontal foreshortening ... */
    const hFace = clamp01((now / rest) * 1.15 - 0.05);
    /* ... and vertical aperture: a squint must close over the eyeball, not
       reveal a white sclera slit around a shrunken iris                */
    const up = d.up.reduce((a, i) => a + D[i].y, 0) / d.up.length;
    const lo = d.lo.reduce((a, i) => a + D[i].y, 0) / d.lo.length;
    const rup = d.up.reduce((a, i) => a + S.head.P[i][1], 0) / d.up.length;
    const rlo = d.lo.reduce((a, i) => a + S.head.P[i][1], 0) / d.lo.length;
    const vFace = clamp01(((lo - up) / Math.max(1, rlo - rup)) * 1.35 - 0.1);
    return Math.min(hFace, vFace);
  }

  function drawLips(S, ctx, D, mw, gap) {
    const O = E.LIPS_O.map(i => D[i]), In = E.LIPS_I.map(i => D[i]);
    const a = D[61], b = D[291];
    if (!polyOK(O, 12) || !polyOK(In, 2.5)) return false;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const dn = { x: -Math.sin(ang), y: Math.cos(ang) };
    const bb = bounds(O);
    const seam = clamp01(1 - gap / (mw * 0.075));
    const lc = { x: (D[17].x + D[14].x) / 2, y: (D[17].y + D[14].y) / 2 };
    const uc = { x: (D[0].x + D[13].x) / 2, y: (D[0].y + D[13].y) / 2 };
    ctx.save();
    ctx.beginPath();
    O.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    In.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(186,66,82,.13)';
    ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 30; i++) {
      const t = (i + .5) / 30, bx = a.x + (b.x - a.x) * t, by = a.y + (b.y - a.y) * t, h = mw * 0.19;
      ctx.strokeStyle = `rgba(84,28,36,${.06 + .05 * (i % 3)})`;
      ctx.beginPath();
      ctx.moveTo(bx - dn.x * h, by - dn.y * h);
      ctx.lineTo(bx + dn.x * h, by + dn.y * h);
      ctx.stroke();
    }
    const gl = (c, rw, rh, al) => {
      if (!(rw > 0.5 && rh > 0.2)) return;
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(ang); ctx.scale(1, rh / rw);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rw);
      g.addColorStop(0, `rgba(255,240,238,${al})`);
      g.addColorStop(1, 'rgba(255,240,238,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, rw, 0, 7); ctx.fill();
      ctx.restore();
    };
    gl(lc, mw * 0.26, mw * 0.05, .36 * (1 - seam * 0.3));
    gl(uc, mw * 0.16, mw * 0.035, .15);
    ctx.restore();
    if (seam > 0.02) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        E.UP_LIP.forEach((i, k) => k ? ctx.lineTo(D[i].x, D[i].y) : ctx.moveTo(D[i].x, D[i].y));
      };
      ctx.filter = 'blur(1.8px)';
      ctx.strokeStyle = `rgba(52,15,22,${.28 * seam})`;
      ctx.lineWidth = Math.max(1, mw * 0.035);
      path(); ctx.stroke();
      ctx.filter = 'blur(.6px)';
      ctx.strokeStyle = `rgba(44,10,16,${.55 * seam})`;
      ctx.lineWidth = Math.max(1, mw * 0.011);
      path(); ctx.stroke();
      ctx.filter = 'none';
      const r = Math.max(1, mw * 0.07);
      for (const P of [a, b]) {
        const g = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, r);
        g.addColorStop(0, `rgba(40,8,14,${.36 * seam})`);
        g.addColorStop(1, 'rgba(40,8,14,0)');
        ctx.fillStyle = g;
        ctx.fillRect(P.x - r, P.y - r, r * 2, r * 2);
      }
      ctx.restore();
    }
    return true;
  }

  /* ------------------------------------------------------- oral cavity */
  /* Dental arch spec: eight teeth per quadrant (central incisor to third
     molar) in natural dentition proportions.  The arch is a circular arc
     of radius R (in mouth widths), so the molars recede and turn away the
     way a real dental arch does instead of sitting flat in the lip plane.
     Only the front six or so can ever clear the lip aperture — the rest
     exist so the arch reads as a curve and the sides never look pasted. */
  function buildArches() {
    return {
      /* w: crown width (mouth widths), h: crown height relative to a
         central incisor, k: outline family (incisal-edge profile)        */
      TEETH: [
        { w: 0.150, h: 1.00, k: 'inc' },     // central incisor
        { w: 0.106, h: 0.84, k: 'inc' },     // lateral incisor
        { w: 0.118, h: 0.97, k: 'can' },     // canine
        { w: 0.100, h: 0.83, k: 'pm' },      // first premolar
        { w: 0.096, h: 0.78, k: 'pm' },      // second premolar
        { w: 0.126, h: 0.72, k: 'mol' },     // first molar
        { w: 0.114, h: 0.68, k: 'mol2' },    // second molar
        { w: 0.100, h: 0.62, k: 'mol2' }     // third molar
      ],
      R: 0.52,                               // arch radius, mouth widths
      BACK: 0.135                            // arch depth behind the lips
    };
  }
  const lerp2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const mixP = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const shade = (c, k) => `rgb(${Math.round(clamp(c[0] * k, 0, 255))},${Math.round(clamp(c[1] * k, 0, 255))},${Math.round(clamp(c[2] * k, 0, 255))})`;
  function mouthFrame(head, C) {
    const a = C[61], b = C[291], up = C[13], lo = C[14];
    const ax = v3.norm(v3.sub(b, a));
    let ay = v3.sub(lo, up);
    const pr = v3.dot(ay, ax);
    ay = v3.norm([ay[0] - ax[0] * pr, ay[1] - ax[1] * pr, ay[2] - ax[2] * pr]);
    const az = v3.norm(v3.cross(ax, ay));
    const mw = v3.dist(a, b) || head.fw * 0.4;
    const org = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    /* lip-line heights measured *relative to org*: absolute projections
       would push the whole dental arch off-canvas                     */
    return { ax, ay, az, org, mw,
             upY: v3.dot(v3.sub(up, org), ay), loY: v3.dot(v3.sub(lo, org), ay) };
  }
  const mfp = (fr, u, v, w) => [
    fr.org[0] + fr.ax[0] * u + fr.ay[0] * v + fr.az[0] * w,
    fr.org[1] + fr.ax[1] * u + fr.ay[1] * v + fr.az[1] * w,
    fr.org[2] + fr.ax[2] * u + fr.ay[2] * v + fr.az[2] * w
  ];

  /* ---- crown outline -------------------------------------------------
     A tooth is the projected gum0-gum1-bite1-bite0 quad, but a real crown
     is not a rounded rectangle: the proximal walls bow out at the contact
     points, the four corners are rounded, the cervical margin arcs toward
     the crown, and the incisal edge carries its family profile (gentle
     arc on incisors, a cusp on canines, an occlusal notch on molars).
     The outline is generated here in screen space from those four
     projected corners, so it stays correct through any head pose.      */
  const EDGE_PROFILE = { inc: 0.10, lat: 0.14, can: 0.34, pm: -0.07, mol: -0.12, mol2: -0.16 };
  function toothPath(ctx, G0, G1, B1, B0, kind) {
    const gm = mixP(G0, G1, 0.5), bm = mixP(B0, B1, 0.5);
    const c0 = mixP(G0, G1, 0.13), c1 = mixP(G1, G0, 0.13);
    const p1 = mixP(c1, B1, 0.15), p2 = mixP(B1, G1, 0.13);
    const p3 = mixP(B1, B0, 0.17), p4 = mixP(B0, B1, 0.17);
    const p5 = mixP(B0, G0, 0.13), p6 = mixP(G0, B0, 0.15);
    const cerv = mixP(gm, bm, 0.13);                       // CEJ arcs toward the crown
    const prof = EDGE_PROFILE[kind] === undefined ? 0.10 : EDGE_PROFILE[kind];
    const edge = mixP(bm, gm, -prof);                      // negative t = past the edge
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.quadraticCurveTo(cerv.x, cerv.y, c1.x, c1.y);
    ctx.quadraticCurveTo(G1.x, G1.y, p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.quadraticCurveTo(B1.x, B1.y, p3.x, p3.y);
    ctx.quadraticCurveTo(edge.x, edge.y, p4.x, p4.y);
    ctx.quadraticCurveTo(B0.x, B0.y, p5.x, p5.y);
    ctx.lineTo(p6.x, p6.y);
    ctx.quadraticCurveTo(G0.x, G0.y, c0.x, c0.y);
    ctx.closePath();
  }

  /* ---- gingiva -------------------------------------------------------
     Drawn behind the crowns: a scalloped margin with a papilla between
     each pair of teeth, a darker sulcus hugging the margin and a band
     that fades toward the lip.  It hangs off the same cervical points as
     the crowns, so the teeth can never drift out of their gums.        */
  function drawGum(ctx, list, isUp, alpha, mw, lum) {
    if (!list.length) return;
    const n = list.length;
    const away = list.map(t => {
      const dx = t.gm.x - t.bm.x, dy = t.gm.y - t.bm.y;
      const l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    });
    const band = Math.max(2.5, mw * 0.095);
    const margin = [];
    for (let i = 0; i < n; i++) {
      margin.push([list[i].gm.x, list[i].gm.y]);
      if (i < n - 1) {
        const a = list[i], b = list[i + 1];
        if ((a.um < 0) !== (b.um < 0)) continue;           // never bridge the midline gap
        const mx = (a.gm.x + b.gm.x) / 2, my = (a.gm.y + b.gm.y) / 2;
        const hh = Math.min(a.hh, b.hh) * 0.42;
        margin.push([mx - (away[i][0] + away[i + 1][0]) * 0.5 * hh,
                     my - (away[i][1] + away[i + 1][1]) * 0.5 * hh]);
      }
    }
    if (margin.length < 2) return;
    const base = margin.map((m, i) => {
      const k = Math.min(away.length - 1, Math.round(i / 2));
      return [m[0] + away[k][0] * band, m[1] + away[k][1] * band];
    });
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(base[0][0], base[0][1]);
    for (let i = 1; i < base.length; i++) ctx.lineTo(base[i][0], base[i][1]);
    for (let i = margin.length - 1; i >= 0; i--) ctx.lineTo(margin[i][0], margin[i][1]);
    ctx.closePath();
    const m0 = base[Math.floor(base.length / 2)], m1 = margin[Math.floor(margin.length / 2)];
    const g = ctx.createLinearGradient(m0[0], m0[1], m1[0], m1[1]);
    g.addColorStop(0, shade([150 + lum * 24, 74 + lum * 18, 78 + lum * 16], 1));
    g.addColorStop(0.58, shade([196 + lum * 24, 112 + lum * 22, 108 + lum * 18], 1));
    g.addColorStop(1, shade([218 + lum * 22, 138 + lum * 20, 130 + lum * 18], 1));
    ctx.fillStyle = g;
    ctx.fill();
    /* sulcus: a soft shadow just under the margin (the pocket line) */
    const sg = ctx.createLinearGradient(m0[0], m0[1], m1[0], m1[1]);
    sg.addColorStop(0.62, 'rgba(58,16,20,0)');
    sg.addColorStop(1, 'rgba(58,16,20,.42)');
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.restore();
  }

  /* Draw one rigid dental arch, clipped to the mouth opening, and return
     visibility diagnostics.

       · the UPPER arch is bolted to the maxilla: its occlusal (bite) plane
         sits at the REST lip line, its crowns hang behind the upper lip and
         nothing about it is read from the moving lip skin, so a smile or a
         head turn can never drag it around;
       · the LOWER arch is bolted to the mandible: its points are rotated
         about the same TMJ axis, with the same angle, as the jaw-weighted
         skin in deform(), so the lower crowns travel with the bone and the
         bite opens exactly as wide as the chin drops;
       · both arches are clipped to the (dilated) inner-lip polygon, so
         enamel can never paint over vermilion or skin.

     Teeth are lit by their angle to the view axis (a head turn shades the
     arch like a curve, not a flat sticker), graded cervix->incisal like
     real enamel, and separated by soft interproximal contacts.         */
  function drawArch(S, ctx, proj3, fr, which, cfg, clipPoly) {
    const A = S.arches;
    const isUp = which === 'up';
    const part = clamp01(cfg.part === undefined ? 1 : cfg.part);
    const vis = clamp01(cfg.vis) * (isUp ? clamp01(part * 2.6) : clamp01((part - 0.12) / 0.88));
    if (vis <= 0.012) return { frontY: null, drawnTeeth: 0, alphaSum: 0 };
    if (!clipPoly || clipPoly.length < 3) return { frontY: null, drawnTeeth: 0, alphaSum: 0 };

    let cx0 = 1e9, cy0 = 1e9, cx1 = -1e9, cy1 = -1e9;
    for (const q of clipPoly) {
      if (q.x < cx0) cx0 = q.x; if (q.x > cx1) cx1 = q.x;
      if (q.y < cy0) cy0 = q.y; if (q.y > cy1) cy1 = q.y;
    }
    if (!(cx1 - cx0 > 2 && cy1 - cy0 > 2)) return { frontY: null, drawnTeeth: 0, alphaSum: 0 };

    const yaw = cfg.yaw || 0;
    const jaw = cfg.jaw || 0;
    const mw = fr.mw;
    const crown = mw * (isUp ? 0.255 : 0.215);
    /* Occlusal plane = the rest lip line.  The maxilla does not move when
       the jaw drops, so the upper incisal edges are anchored there; a
       small opening-driven reveal keeps the classic "teeth come out from
       behind the lip" read without ever letting them float.             */
    const lipLine = (fr.upY + fr.loY) / 2;
    const reveal = clamp((cfg.open || 0) * mw * 0.24, 0, crown * 0.34);
    const vBite = isUp ? lipLine + mw * 0.014 + reveal : lipLine - mw * 0.022;
    /* the mandible rotation the skin got this frame (deform writes it) */
    const jawR = !isUp && Math.abs(jaw) > 1e-4 && S.axis ? FM.m3.fromAxisAngle(S.axis.dir, jaw) : null;
    const place = (p) => {
      if (!jawR) return p;
      const rel = [p[0] - S.axis.p[0], p[1] - S.axis.p[1], p[2] - S.axis.p[2]];
      const r = FM.m3.mv(jawR, rel);
      return [S.axis.p[0] + r[0], S.axis.p[1] + r[1], S.axis.p[2] + r[2]];
    };
    const teeth = [];
    for (let sd = 0; sd < 2; sd++) {
      let cum = 0;
      const sgn = sd ? 1 : -1;
      for (let j = 0; j < A.TEETH.length; j++) {
        const spec = A.TEETH[j];
        const wj = spec.w * (isUp ? 1 : 0.94);
        const th0 = cum / A.R, th1 = (cum + wj) / A.R;
        const u0 = (A.R * Math.sin(th0) + 0.002) * sgn;
        const u1 = (A.R * Math.sin(th1) - 0.002) * sgn;
        const th = (th0 + th1) / 2;
        const um = A.R * Math.sin(th) * sgn;
        cum += wj;
        const back = A.BACK + A.R * (1 - Math.cos(th)) + j * 0.010;
        const hh = crown * spec.h * (1 + (((j * 13 + (sd ? 5 : 0)) % 7) - 3) * 0.011);
        const vGum = vBite + (isUp ? -hh : hh);
        const q = [
          place(mfp(fr, u0 * mw, vGum, -mw * back)),
          place(mfp(fr, u1 * mw, vGum, -mw * back)),
          place(mfp(fr, u1 * mw, vBite, -mw * (back - 0.030))),
          place(mfp(fr, u0 * mw, vBite, -mw * (back - 0.030)))
        ].map(proj3).map(v => ({ x: v[0], y: v[1], z: v[2] }));
        if (!q.every(v => isFinite(v.x) && isFinite(v.y))) continue;
        const G0 = q[0], G1 = q[1], B1 = q[2], B0 = q[3];
        const x0 = Math.min(G0.x, G1.x, B0.x, B1.x), x1 = Math.max(G0.x, G1.x, B0.x, B1.x);
        const y0 = Math.min(G0.y, G1.y, B0.y, B1.y), y1 = Math.max(G0.y, G1.y, B0.y, B1.y);
        if (x1 < cx0 - 2 || x0 > cx1 + 2 || y1 < cy0 - 2 || y0 > cy1 + 2) continue;
        teeth.push({ G0, G1, B1, B0, j, sd, th, back, hh, kind: spec.k,
                     gm: mixP(G0, G1, 0.5), bm: mixP(B0, B1, 0.5), um,
                     box: [x0, y0, x1, y1] });
      }
    }
    if (!teeth.length) return { frontY: null, drawnTeeth: 0, alphaSum: 0 };
    teeth.sort((a, b) => b.back - a.back);                 // molars first, centrals last
    const lum = clamp01(S.cache.lum);
    const bright = clamp01((0.55 + lum * 0.45) * (cfg.bright === undefined ? 1 : cfg.bright));
    const warm = clamp01(cfg.warmth);
    /* Enamel palette from the photo's own skin luminance/warmth: never pure
       white (that reads as paper), always a warm ivory body with a cooler,
       more translucent incisal third.  Values stay under 250 so the head
       turn highlight has somewhere to go.                              */
    const cerv = [201 - warm * 10, 180 - warm * 12, 143 - warm * 16];
    const body = [236 - warm * 4, 229 - warm * 6, 210 - warm * 10];
    const incis = [239, 239, 232];
    const trans = [216, 227, 238];                         // incisal halo (bluish)
    let frontY = null, frontZ = null, drawnTeeth = 0, alphaSum = 0;
    ctx.save();
    ctx.beginPath();
    clipPoly.forEach((pt, i) => i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y));
    ctx.closePath();
    ctx.clip();

    /* gum first (behind the crowns), in arch order so the papillae land
       between neighbouring teeth */
    const gumOrder = teeth.slice().sort((a, b) => a.um - b.um);
    drawGum(ctx, gumOrder, isUp, vis * 0.92, mw, lum);

    for (const t of teeth) {
      const { G0, G1, B1, B0, gm, bm, hh } = t;
      const alpha = clamp01(vis * (1 - Math.min(0.55, Math.max(0, t.back - A.BACK) * 0.55)));
      if (alpha <= 0.02) continue;
      alphaSum += alpha;
      /* a tooth angled away from the view axis catches less light */
      const light = clamp(0.44 + 0.56 * Math.cos(t.th - yaw * 0.85), 0.22, 1) * (0.74 + bright * 0.26) * (isUp ? 1 : 0.90);
      const tint = 1 + (((t.j * 29 + (t.sd ? 7 : 0)) % 5) - 2) * 0.006;   // per-tooth hue jitter
      ctx.save();
      ctx.globalAlpha = alpha;
      const path = () => toothPath(ctx, G0, G1, B1, B0, t.kind);
      /* ---- enamel body: cervix (warm, opaque) -> incisal (cool, clear) */
      path();
      const g = ctx.createLinearGradient(gm.x, gm.y, bm.x, bm.y);
      g.addColorStop(0, shade(cerv, light * 0.90 * tint));
      g.addColorStop(0.30, shade(body, light * 0.99 * tint));
      g.addColorStop(0.72, shade(body, light * 1.02 * tint));
      g.addColorStop(1, shade(incis, light * 1.0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      path();
      ctx.clip();
      /* buccal curvature: both proximal walls fall away from the light */
      const side = ctx.createLinearGradient(G0.x, G0.y, G1.x, G1.y);
      side.addColorStop(0, `rgba(92,64,44,${0.26 * light})`);
      side.addColorStop(0.26, 'rgba(92,64,44,0)');
      side.addColorStop(0.74, 'rgba(92,64,44,0)');
      side.addColorStop(1, `rgba(92,64,44,${0.26 * light})`);
      ctx.fillStyle = side;
      ctx.fill();
      /* cervical third: the neck of the tooth sits in the gingival sulcus */
      const cervG = ctx.createLinearGradient(gm.x, gm.y, bm.x, bm.y);
      cervG.addColorStop(0, `rgba(96,52,32,${0.34 * light})`);
      cervG.addColorStop(0.26, 'rgba(96,52,32,0)');
      ctx.fillStyle = cervG;
      ctx.fill();
      /* incisal translucency: the enamel thins to a clear halo at the edge */
      const halo = ctx.createLinearGradient(bm.x, bm.y, gm.x, gm.y);
      halo.addColorStop(0, `rgba(${trans[0]},${trans[1]},${trans[2]},${(isUp ? 0.20 : 0.13) * light})`);
      halo.addColorStop(0.12, `rgba(${trans[0]},${trans[1]},${trans[2]},${0.07 * light})`);
      halo.addColorStop(0.30, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.fill();
      /* occlusal shadow cast by the opposing arch (grows as the bite closes) */
      const occ = ctx.createLinearGradient(bm.x, bm.y, gm.x, gm.y);
      const occA = isUp ? 0.09 : 0.20;
      occ.addColorStop(0, `rgba(46,22,18,${occA * light})`);
      occ.addColorStop(isUp ? 0.24 : 0.34, 'rgba(46,22,18,0)');
      ctx.fillStyle = occ;
      ctx.fill();
      /* specular: a soft vertical streak on the buccal face of the fronts */
      if (t.j < 5) {
        const wpx = Math.hypot(G1.x - G0.x, G1.y - G0.y);
        const c = mixP(mixP(G0, G1, 0.5), mixP(B0, B1, 0.5), 0.38);
        const r = Math.max(1.5, wpx * 0.34);
        const rg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        rg.addColorStop(0, `rgba(255,255,250,${0.18 * bright * light})`);
        rg.addColorStop(1, 'rgba(255,255,250,0)');
        ctx.fillStyle = rg;
        ctx.fill();
        /* mamelons: the three soft lobes young incisors carry near the edge */
        if (t.kind === 'inc' && hh > mw * 0.06) {
          ctx.strokeStyle = `rgba(255,253,246,${0.07 * light})`;
          ctx.lineWidth = Math.max(0.5, mw * 0.006);
          const dirX = (bm.x - gm.x) * 0.26, dirY = (bm.y - gm.y) * 0.26;
          for (const off of [-0.20, 0.20]) {
            const a = mixP(gm, bm, 0.62), b = mixP(gm, bm, 0.88);
            const ox = (G1.x - G0.x) * off, oy = (G1.y - G0.y) * off;
            ctx.beginPath();
            ctx.moveTo(a.x + ox, a.y + oy);
            ctx.lineTo(b.x + ox + dirX * 0.12, b.y + oy + dirY * 0.12);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
      /* proximal contact: a hairline of shadow where the crowns touch */
      ctx.strokeStyle = `rgba(70,40,30,${0.20 * alpha})`;
      ctx.lineWidth = Math.max(0.6, mw * 0.0055);
      ctx.beginPath(); ctx.moveTo(G0.x, G0.y); ctx.lineTo(B0.x, B0.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(G1.x, G1.y); ctx.lineTo(B1.x, B1.y); ctx.stroke();
      ctx.restore();
      const edgeY = (B0.y + B1.y) / 2;
      if (frontY === null || (isUp ? edgeY > frontY : edgeY < frontY)) {
        frontY = edgeY;
        frontZ = (B0.z + B1.z) / 2;
      }
      drawnTeeth++;
    }
    /* incisal contact shadow: the arch throws a soft shadow into the
       cavity, which is what stops a row of crowns from reading as a
       bright cardboard strip against black.  Painted last, inside the
       aperture clip, so it only touches the gap below the teeth.      */
    if (frontY !== null) {
      const band = mw * (isUp ? 0.10 : 0.075);
      const y0 = isUp ? frontY : frontY - band;
      const g = ctx.createLinearGradient(0, isUp ? frontY : frontY, 0, isUp ? frontY + band : frontY - band);
      g.addColorStop(0, `rgba(22,7,9,${(isUp ? 0.42 : 0.30) * vis})`);
      g.addColorStop(1, 'rgba(22,7,9,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx0, y0, Math.max(1, cx1 - cx0), Math.max(1, band));
    }
    ctx.restore();
    /* the clip polygon is the real incisal boundary: report the VISIBLE
       edge, not the unclipped geometric one (a wide-open jaw shows a
       partial crown by design — the lips crop the rest)               */
    /* rawY keeps the unclipped geometric edge: the clamped one saturates
       against the aperture, so it cannot tell "the arch moved" from "the
       lips cropped more" (tests read rawY for bone motion).            */
    const rawY = frontY, rawZ = frontZ;
    if (frontY !== null) frontY = isUp ? Math.min(frontY, cy1) : Math.max(frontY, cy0);
    return { frontY, rawY, rawZ, drawnTeeth, alphaSum, jaw: cfg.jaw || 0 };
  }

  function drawCavity(S, ctx, D, h) {
    const In = E.LIPS_I.map(i => D[i]);
    if (!polyOK(In, 2.5)) return false;
    const bb = bounds(In);
    ctx.save();
    ctx.beginPath();
    In.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(D[13].x, D[13].y, D[14].x, D[14].y);
    g.addColorStop(0, `rgba(70,20,24,${0.85 * h})`);
    g.addColorStop(.55, `rgba(28,7,10,${0.95 * h})`);
    g.addColorStop(1, `rgba(18,4,7,${0.9 * h})`);
    ctx.fillStyle = g;
    ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    const mx = (D[13].x + D[14].x) / 2, my = (D[13].y + D[14].y) / 2;
    const mw = Math.hypot(D[61].x - D[291].x, D[61].y - D[291].y) || S.head.fw * 0.4;
    const r = Math.max(2, mw * 0.34);
    const rg = ctx.createRadialGradient(mx, my, 1, mx, my, r);
    rg.addColorStop(0, `rgba(3,0,1,${0.8 * h})`);
    rg.addColorStop(1, 'rgba(3,0,1,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    /* ---- tongue + floor of the mouth -------------------------------
       A jaw drop does not reveal a black keyhole: behind the arches the
       tongue catches a little of the same key light, and its mass sits low
       in the aperture.  Two soft gradients are enough to make the cavity
       read as depth instead of a hole, and they fade with the opening so
       a nearly shut mouth stays dark.                                 */
    const openV = Math.max(0, D[14].y - D[13].y);
    if (openV > mw * 0.10) {
      const tk = clamp01((openV - mw * 0.08) / (mw * 0.22)) * h;
      const ty = my + openV * 0.30;
      const tw = Math.max(3, mw * 0.30), thh = Math.max(2, mw * 0.12);
      ctx.save();
      ctx.translate(mx, ty);
      ctx.scale(1, thh / tw);
      const tg = ctx.createRadialGradient(0, 0, 0, 0, 0, tw);
      tg.addColorStop(0, `rgba(148,72,70,${0.62 * tk})`);
      tg.addColorStop(0.62, `rgba(116,50,52,${0.34 * tk})`);
      tg.addColorStop(1, 'rgba(84,32,36,0)');
      ctx.fillStyle = tg;
      ctx.beginPath(); ctx.arc(0, 0, tw, 0, 7); ctx.fill();
      ctx.restore();
      /* palatal shadow: the roof of the mouth is the darkest surface */
      const pal = ctx.createLinearGradient(mx, D[13].y, mx, my);
      pal.addColorStop(0, `rgba(26,8,10,${0.55 * h})`);
      pal.addColorStop(1, 'rgba(26,8,10,0)');
      ctx.fillStyle = pal;
      ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    }
    ctx.restore();
    return true;
  }

  /* ------------------------------------------------------ pinna shading
     The photo supplies ear texture; this pass supplies ear *shape*: a
     concha bowl shadow, a helix rim light and the antihelix/lobe creases,
     painted in the projected ear frame.  The near ear gains relief as it
     swings into view; the far ear loses it as it tucks away, so the
     shading never pops between the two.                                 */
  function drawEars(S, ctx, D, st) {
    const yaw = E.eulerYaw(st.q);
    S.earShade = envelope(S.earShade || 0, clamp01(Math.abs(yaw) * 2.4), st.dt || 1 / 60, 6, 6);
    const tn = S.earShade;
    for (const [trag, above, lobe] of [[234, 127, 132], [454, 323, 361]]) {
      const T = D[trag], A = D[above], L = D[lobe];
      if (!T || !A || !L || !isFinite(T.x + A.x + L.x)) continue;
      const eh = Math.hypot(A.x - L.x, A.y - L.y);
      if (eh < 6) continue;
      const dirX = T.x < S.mid[0] ? -1 : 1;
      const cx = (T.x * 2 + A.x + L.x) / 4 + dirX * eh * 0.10;
      const cy = (T.y * 2 + A.y + L.y) / 4;
      const near = (yaw >= 0) === (dirX < 0);
      const facing = near ? 0.55 + 0.45 * tn : 0.63 * (1 - tn) + 0.06;
      if (facing <= 0.03) continue;
      const tilt = Math.atan2(A.x - L.x, -(A.y - L.y));
      const ewd = eh * 0.58;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.scale(ewd / 2, eh / 2);
      /* concha bowl */
      const dark = 0.34 * facing * (0.45 + tn * 0.8);
      const concha = ctx.createRadialGradient(-dirX * 0.22, 0.06, 0.05, -dirX * 0.22, 0.06, 0.8);
      concha.addColorStop(0, `rgba(50,25,21,${dark})`);
      concha.addColorStop(0.55, `rgba(50,25,21,${dark * 0.45})`);
      concha.addColorStop(1, 'rgba(50,25,21,0)');
      ctx.fillStyle = concha;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill();
      /* helix rim light on the outer edge */
      const lit = 0.26 * facing * (0.35 + tn * 0.9);
      const rim = ctx.createLinearGradient(dirX * 0.1, -0.9, dirX * 1.0, 0.5);
      rim.addColorStop(0, 'rgba(255,238,224,0)');
      rim.addColorStop(0.7, `rgba(255,238,224,${lit * 0.45})`);
      rim.addColorStop(1, `rgba(255,238,224,${lit})`);
      ctx.fillStyle = rim;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill();
      /* antihelix fold + lobe crease */
      ctx.strokeStyle = `rgba(70,36,30,${0.20 * facing})`;
      ctx.lineWidth = 0.09;
      ctx.beginPath(); ctx.moveTo(-dirX * 0.10, -0.75); ctx.quadraticCurveTo(dirX * 0.45, -0.1, -dirX * 0.05, 0.55); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-dirX * 0.30, 0.72); ctx.quadraticCurveTo(dirX * 0.10, 0.95, dirX * 0.42, 0.66); ctx.stroke();
      ctx.restore();
    }
  }

  function drawShading(S, ctx, D, st) {
    const yaw = E.eulerYaw(st.q);
    const amt = clamp01(Math.abs(yaw) * 0.9 * (st.shade || 0));
    if (amt < 0.012) return;
    const poly = E.CONTOUR.map(i => D[i]);
    if (!polyOK(poly, 20)) return;
    const bb = bounds(poly);
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.clip();
    const left = yaw < 0;
    const g = ctx.createLinearGradient(left ? bb.x0 : bb.x1, 0, left ? bb.x1 : bb.x0, 0);
    g.addColorStop(0, `rgba(22,12,14,${amt})`);
    g.addColorStop(.45, 'rgba(22,12,14,0)');
    g.addColorStop(1, `rgba(255,244,236,${amt * 0.32})`);
    ctx.fillStyle = g;
    ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.w + 4, bb.h + 4);
    ctx.restore();
  }

  /* ------------------------------------------------------------- frame */
  function sessionFrame(S, st) {
    if (!S.ready) return null;
    S.frames++;
    const ctx = st.ctx || S.canvas.getContext('2d');
    const lc = S.lctx;
    const C = deform(S, st);
    const D = new Array(478);
    for (let i = 0; i < 478; i++) D[i] = { x: S.DST[i * 2], y: S.DST[i * 2 + 1], z: S.depth[i] };
    S.stats.tris = 0; S.stats.culled = 0; S.stats.earBand = 0; S.stats.earFaded = 0; S.stats.earDetailSkipped = 0;
    S.stats.skipTiny = 0; S.stats.skipComp = 0; S.stats.skipAff = 0; S.stats.flatFill = 0; S.stats.drawnA = 0; S.stats.drawnB = 0;
    if (S.dbgBox) S.dbg = [];
    /* ---- compose the shell on the layer, then blit once ------------ */
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, S.W, S.H);
    lc.drawImage(S.cache.plate || S.src, 0, 0);
    lc.imageSmoothingQuality = st.quality > 0 ? 'high' : 'low';
    drawShell(S, lc, st, S.triA, { resetOrder: S.frames < 3, padScale: st.quality > 1 ? 1.4 : 1 });
    S.stats.drawnA = S.stats.tris;
    if (st.quality > 0) drawShell(S, lc, st, S.triB, { resetOrder: S.frames < 3, padScale: st.quality > 1 ? 1.4 : 1 });
    S.stats.drawnB = S.stats.tris - S.stats.drawnA;
    if (S.dbg) S.lastDbg = S.dbg;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S.W, S.H);
    let mw = 0, gap = 0, h = S.openEnv;
    const oral = { cavity: false, lowerTeeth: 0, lowerAlpha: 0, upperTeeth: 0, upperAlpha: 0, lips: false };
    if (st.origOnly) {
      ctx.drawImage(S.src, 0, 0);
    } else {
      ctx.drawImage(S.layer, 0, 0);
      /* ---- accessories -------------------------------------------- */
      /* teeth hang off the REST skull, not off the deformed lip skin: the
         maxilla does not move when the jaw drops, and the mandible arch is
         rotated by the bone angle inside drawArch.  Using C here made the
         arches chase the lips (they slid with every smile).             */
      const fr = mouthFrame(S.head, S.head.P);
      mw = Math.hypot(S.DST[61 * 2] - S.DST[291 * 2], S.DST[61 * 2 + 1] - S.DST[291 * 2 + 1]) || S.head.fw * 0.4;
      const rawGap = Math.hypot(S.DST[13 * 2] - S.DST[14 * 2], S.DST[13 * 2 + 1] - S.DST[14 * 2 + 1]);
      gap = Math.max(0, rawGap - mw * 0.035);
      S.openEnv = envelope(S.openEnv, clamp01(gap / (mw * 0.30)), st.dt || 1 / 60, 14, 9);
      h = S.openEnv;
      const zc = st.depthGain || 0;
      /* Accessories must live in the same space as the mesh.  The shell is
         painted at S2 + (proj(cur) - proj0(base)) — an absolute proj() is
         NOT the screen position (dolly scale and pivot live inside it), so
         a dental arch placed with proj() alone lands tens of pixels off
         the lips whenever the tracker dollies.  archMap reproduces the
         shell's own displacement for a rest point, so teeth stay welded
         to the face instead of floating in projection space.           */
      const archMap = (p) => {
        const pz = p[2] * (1 + zc);
        const a = S.proj([p[0], p[1], pz]);
        const b = S.proj0([p[0], p[1], pz]);
        return [p[0] + (a[0] - b[0]), p[1] + (a[1] - b[1]), a[2]];
      };
      const proj3 = archMap;
      if (h > 0.004) oral.cavity = drawCavity(S, ctx, D, h) === true;
      /* teeth are clipped to the (slightly dilated) inner-lip polygon so
         they can never paint onto skin or over the vermilion           */
      const In = E.LIPS_I.map(i => D[i]);
      let clipPoly = null;
      if (polyOK(In, 1.0)) {
        let gx = 0, gy = 0;
        for (const p of In) { gx += p.x / In.length; gy += p.y / In.length; }
        /* fixed 3px radial dilation: a proportional one overshoots the
           vermilion at the corners exactly when the mouth is wide open */
        clipPoly = In.map(p => {
          const vx = p.x - gx, vy = p.y - gy, l = Math.hypot(vx, vy) || 1;
          const k = (l + 3) / l;
          return { x: gx + vx * k, y: gy + vy * k };
        });
      }
      const part = clamp01((gap - mw * 0.02) / (mw * 0.16));
      const yawNow = E.eulerYaw(st.q);
      const cfg = { vis: st.vis, bright: st.bright, warmth: st.warmth, part, yaw: yawNow,
                    open: gap / Math.max(1, mw), jaw: S.jawAng || 0 };
      const lower = drawArch(S, ctx, proj3, fr, 'lo', cfg, clipPoly);
      oral.lowerTeeth = lower.drawnTeeth; oral.lowerAlpha = lower.alphaSum;
      const upper = drawArch(S, ctx, proj3, fr, 'up', cfg, clipPoly);
      oral.upperTeeth = upper.drawnTeeth; oral.upperAlpha = upper.alphaSum;
      oral.upperFrontY = upper.frontY; oral.lowerFrontY = lower.frontY;
      oral.upperRawY = upper.rawY; oral.lowerRawY = lower.rawY;
      oral.upperRawZ = upper.rawZ; oral.lowerRawZ = lower.rawZ;
      oral.archJaw = lower.jaw;
      oral.clip = clipPoly ? 1 : 0; oral.part = part;
      oral.orgY = archMap(fr.org)[1];
      if (clipPoly) {
        let iy0=1e9,iy1=-1e9,ix0=1e9,ix1=-1e9;
        for (const q of clipPoly){ if(q.y<iy0)iy0=q.y; if(q.y>iy1)iy1=q.y; if(q.x<ix0)ix0=q.x; if(q.x>ix1)ix1=q.x; }
        oral.lipBox=[Math.round(ix0),Math.round(iy0),Math.round(ix1),Math.round(iy1)];
      }
      oral.lips = drawLips(S, ctx, D, mw, gap) === true;
      const eyeFace = [eyeFacing(S, D, 0), eyeFacing(S, D, 1)];
      drawIris(S, ctx, 0, D, st.gaze[0], st.gazeGain, eyeFace[0]);
      drawIris(S, ctx, 1, D, st.gaze[1], st.gazeGain, eyeFace[1]);
      drawEyelid(S, ctx, 'L', st.lid[0], D);
      drawEyelid(S, ctx, 'R', st.lid[1], D);
      drawEars(S, ctx, D, st);
      drawShading(S, ctx, D, st);
    }
    /* ---- overlays -------------------------------------------------- */
    if (st.showPoints && st.points) {
      ctx.save();
      for (let k = 0; k < st.points.length; k++) {
        const def = st.points[k];
        const px = st.origOnly ? S.S2[def.v * 2] : S.DST[def.v * 2];
        const py = st.origOnly ? S.S2[def.v * 2 + 1] : S.DST[def.v * 2 + 1];
        const hot = def.k === st.dragIndex || def.k === st.hoverIndex;
        ctx.beginPath();
        ctx.arc(px, py, hot ? 8 : 4.2, 0, 7);
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, hot ? 6 : 2.8, 0, 7);
        ctx.fillStyle = def.c;
        ctx.fill();
      }
      ctx.restore();
    }
    if (st.showMesh) {
      ctx.save();
      ctx.strokeStyle = 'rgba(94,234,212,.30)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const list = S.triA.list;
      for (let t = 0; t < list.length; t += 3) {
        const a = list[t], b = list[t + 1], c = list[t + 2];
        if (S.mesh.kind[a] === 2 && S.mesh.kind[b] === 2 && S.mesh.kind[c] === 2) continue;
        ctx.moveTo(S.DST[a * 2], S.DST[a * 2 + 1]);
        ctx.lineTo(S.DST[b * 2], S.DST[b * 2 + 1]);
        ctx.lineTo(S.DST[c * 2], S.DST[c * 2 + 1]);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
    const dbg = { tris: S.stats.tris, culled: S.stats.culled,
                  ear: { band: S.stats.earBand || 0, faded: S.stats.earFaded || 0,
                         detailSkipped: S.stats.earDetailSkipped || 0 },
                  mouth: { mw, gap, h, ...oral }, jaw: S.jaw };
    S.lastDebug = dbg;
    return dbg;
  }

  root.FMRender = { createSession, sessionInit, sessionFrame, deform, buildPlate, prepIris, makeCanvas,
                    mouthFrame, mfp, buildArches };
})(typeof globalThis !== 'undefined' ? globalThis : this);
