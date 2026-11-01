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
- **Teeth that read as teeth** — sixteen HD crowns per arch: the upper set is
  anchored to the maxilla (it sits behind the upper lip and barely moves when
  the jaw drops), the lower set is bolted to the hinged mandible and swings with
  it. Per-tooth enamel gradients, papilla gum band, occlusion shadow and
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

## Android app

`release/FacePuppet.apk` is the same page wrapped in a WebView shell, and it is
self-contained: `puppet.html`, the MediaPipe model (`face_landmarker.task`), both
WASM runtimes (SIMD and fallback) and the demo portrait are packaged inside, so
the app works with the network switched off — it does not even request
`android.permission.INTERNET`.

```bash
npm run apk            # build + sign -> release/FacePuppet.apk
npm run lint:smali     # static check of the hand-written smali shell
```

`tools/build-apk.mjs` locates a JDK, downloads `apktool.jar`/`apksigner.jar`
once into `.apk-tools/`, regenerates `puppet.html`, stages `android/assets/`,
compiles `android/smali/`, signs with `android/facepuppet.keystore` (v2 + v3)
and prints a verification summary. Everything under `android/` except the shell
sources is generated and git-ignored; the signing key (`android/facepuppet.keystore`,
all passwords `facepuppet`) is created on first build — keep it, because Android
only accepts an update that is signed with the same key.

Side-load it with `adb install -r release/FacePuppet.apk`, or copy the file to
the phone and open it (allow "install unknown apps" once). Package
`ai.arena.facepuppet`, minSdk 24 (Android 7.0), targetSdk 33, portrait, camera +
microphone only.

- `MainActivity` — hosts the `WebView`, hides the system bars, asks for camera
  and microphone up front and releases the camera when the app is backgrounded.
- `AssetClient` — serves `assets/**` over
  `https://appassets.androidplatform.net/` so the page runs in a secure context
  (`getUserMedia` needs one; `file:///android_asset/` is not).
- `PuppetChrome` — forwards `getUserMedia` permission prompts and `<input
  type=file>` image picking from the page to the Android app.

`tools/make-icons.mjs` draws the launcher icon — legacy 48–192 px, round,
adaptive foreground/background and the API 33 themed layer — and writes it into
`android/res`; the PNGs are committed, so an APK build never needs the canvas
dependency (`npm i --no-save @napi-rs/canvas && node tools/make-icons.mjs`).

The shell is hand-written smali (no Android SDK or Gradle is available in this
repository's build sandbox), so `npm run lint:smali` is the safety net: it
checks register ranges, invoke arity, `move-result` placement, branch labels and
own-class member references, and fails the build on any error.
