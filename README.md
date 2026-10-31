# FacePuppet

A still portrait becomes a **2.5D face puppet** driven live by your webcam.
There are two pages:

- **[`index.html`](index.html) — the standalone single-file app.** All HTML,
  CSS and JavaScript in one file; no build step, backend, API key or local
  assets required. It loads pinned Three.js 0.186.1, MediaPipe Tasks Vision
  1.1.0 and the FaceLandmarker model from CDNs (Delaunator 5.1.0 is inlined),
  builds a textured Three.js portrait mesh (Delaunay, once per photo) with a
  layered procedural mouth, and retargets calibrated head-pose + blendshape
  deltas onto it. Works from `localhost` or any static HTTPS host.
- [`puppet.html`](puppet.html) — the advanced Canvas-2D demo (generated from
  `src/`): hair-shell warping, click-to-sculpt, expression presets, audio
  visemes and WebM recording. Needs `npm run build:puppet` after editing
  sources.

Both process photos and webcam frames locally in the browser; nothing is
uploaded. Animate only photos you own or have permission to use.

## Run it

```bash
npm install          # delaunator, used by the test harness
npm run dev          # build puppet.html + serve on http://localhost:4173
```

Open <http://localhost:4173/index.html> for the single-file app, or
<http://localhost:4173/puppet.html> for the advanced demo (Chrome/Edge
recommended). `index.html` also runs from any static server, e.g.
`python3 -m http.server 8000`. Webcam access needs `http://localhost` or
`https://` (not `file://`).

## What's in the box (index.html)

- **2.5D portrait mesh** — 478 landmarks + pinned boundary, one Delaunay
  triangulation, landmark-derived UVs, depth from detector-z blended with
  nose/cheek/lip/eye-socket/chin priors, feathered head layer over a static
  background, yaw/pitch/roll limits ≈ ±25°/±15°/±20°.
- **Calibrated retargeting** — jaw, smile, pucker, funnel, blinks, wide eyes,
  gaze (look up/down/in/out), brows, cheek puff and head pose as
  neutral-relative deltas with One Euro smoothing, outlier rejection and
  tracking-loss ease-out.
- **Layered mouth** — deforming lips, dark cavity, separately rigged
  procedural upper/lower dental arches plus gum and tongue, all clipped to
  the live lip aperture (teeth are stand-ins, not the real dentition).
- **Clean blinks** — eyelid deformation plus skin-textured lid covers so the
  open-eye photo texture never shows through closed lids.
- **Studio UI** — drag-and-drop upload, mirrored webcam preview, landmark and
  wireframe toggles, motion/expression/mouth/eye/smoothing/depth sliders,
  teeth visibility, PNG snapshot, and clear loading/permission/tracking/error
  states. Accessible and mobile-friendly.

## Development

```bash
npm run check:index    # validate the single-file app (syntax, pins, ids, indices)
npm run build:puppet   # regenerate puppet.html from src/puppet/*
npm run check          # syntax + stale-page check + index validation
npm test               # checks + math verify + headless harness (mock DOM, synthetic face)
```

`puppet.html` is generated from
[`src/puppet/puppet.src.html`](src/puppet/puppet.src.html) plus the inlined
modules `src/math.js`, `src/puppet/engine.js`, `src/puppet/render.js` and
`src/puppet/ui.js`. Edit the sources, rebuild, and keep the committed page
current (`npm run check` fails otherwise). `index.html` is hand-maintained;
`tools/check-index.mjs` guards its pins, DOM ids and landmark tables.

MediaPipe runtime, WASM and the face model are vendored under `vendor/` for
the `puppet.html` demo; the standalone `index.html` loads pinned CDN builds
instead so the single file has no local dependencies.
