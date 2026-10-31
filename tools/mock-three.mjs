/* Test-only three.js stand-in: real math/geometry/texture classes, but a
   headless WebGLRenderer (Node has no GL). Explicit named exports win over
   `export *`, so the harness gets the mock renderer only. */
export * from 'three';

export class WebGLRenderer {
  constructor(opts = {}) {
    this.canvas = opts.canvas || null;
    this.outputColorSpace = null;
    this.autoClear = true;
    this._pr = 1;
    this._size = { w: 0, h: 0 };
    this.renders = 0;
  }
  getContext() { return {}; }
  setPixelRatio(pr) { this._pr = pr; }
  getPixelRatio() { return this._pr; }
  setSize(w, h) {
    this._size = { w, h };
    if (this.canvas) { this.canvas.width = Math.round(w * this._pr); this.canvas.height = Math.round(h * this._pr); }
  }
  render() { this.renders++; }
  dispose() {}
}
