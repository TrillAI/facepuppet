# FacePuppet

A still portrait becomes a **2.5D face puppet**: 478 MediaPipe landmarks are
lifted into canonical head space, wrapped in a hair-shell and pinned collar,
and driven live by your webcam — head turns use a weighted Kabsch fit with
real turn parallax, expressions stay separated from pose, and a hinged
mandible reveals lit dental arches when the mouth opens.

**The app is a single page: [`puppet.html`](puppet.html).** `index.html` is
only a redirect stub. There is no 3D studio and no backend; webcam frames are
processed in the browser and never uploaded.

## Run it

```bash
npm install          # delaunator, used by the test harness
npm run dev          # build puppet.html + serve on http://localhost:4173
```

Open <http://localhost:4173> (Chrome/Edge recommended). A bundled demo
portrait loads automatically so the puppet is alive immediately; press
**Start webcam** for live control, or choose your own photo. Webcam access
needs `http://` or `https://` (not `file://`).

## What's in the box

- **Realistic head turns** — weighted Kabsch pose fit, one-euro filtering,
  quaternion slew, skull-pivot perspective, far-side compression and
  ear swing; anatomical soft limits keep neck and collar pinned.
- **Teeth that read as teeth** — rigid upper/lower arches hinged on the
  mandible, per-tooth enamel gradients, gum band, occlusion shadow and
  interproximal contacts, clipped to the inner-lip aperture.
- **Better ears** — tragion-band weights recess the pinnae behind the cheek
  plane, with concha/helix shading and far-ear fade as the head turns.
- **Expressions** — preset layers (smile, laugh, talk, squint…), optional
  webcam residual mix, audio visemes from the microphone, idle blinking.
- **Click-to-sculpt** — drag landmarks in canonical space (undo, symmetry).
- **Export** — save a PNG or record a WebM of the stage.

## Development

```bash
npm run build:puppet   # regenerate puppet.html from src/puppet/*
npm run check          # syntax + stale-page check
npm test               # verify + headless harness (mock DOM, synthetic face)
```

`puppet.html` is generated from
[`src/puppet/puppet.src.html`](src/puppet/puppet.src.html) plus the inlined
modules `src/math.js`, `src/puppet/engine.js`, `src/puppet/render.js` and
`src/puppet/ui.js`. Edit the sources, rebuild, and keep the committed page
current (`npm run check` fails otherwise).

MediaPipe runtime, WASM and the face model are vendored under `vendor/`;
a pinned CDN is used only as a fallback when an asset is missing.
