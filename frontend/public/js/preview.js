/**
 * Rendered preview for the final asset.
 *
 * While the mock production pipeline returns assets with `url: null`, the
 * player falls back to this canvas renderer: an 8-second, 9:16 product
 * sequence matching the confirmed creative direction (soft morning light,
 * slow macro push-in, subtle rotation). When a real production service
 * returns a playable URL, the player uses a <video> element instead and
 * this module is never invoked.
 */

export class RenderedPreview {
  constructor(canvas, { durationSeconds = 8, palette = ["#F5F1EA", "#D9CDBD", "#A98F72", "#3E362E"] } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.duration = durationSeconds;
    this.palette = palette;
    this.playing = false;
    this.t = 0; // seconds into the sequence
    this._last = 0;
    this._raf = 0;
    this.onProgress = null;
    this._resize();
    this._drawFrame(0);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || Math.round((w * 16) / 9);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.t = (this.t + (now - this._last) / 1000) % this.duration;
      this._last = now;
      this._drawFrame(this.t);
      if (this.onProgress) this.onProgress(this.t / this.duration, this.t);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
  }

  destroy() {
    this.pause();
  }

  _drawFrame(t) {
    if (this.canvas.clientWidth && this.canvas.clientWidth !== this.w) this._resize();
    const { ctx, w, h } = this;
    const p = t / this.duration; // 0..1
    const [paper, sand, bronze, ink] = this.palette;

    // Background: warm-neutral wall with slow morning-light sweep.
    const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
    bg.addColorStop(0, paper);
    bg.addColorStop(1, sand);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Soft light beam drifting slowly across the frame.
    const beamX = w * (0.2 + 0.25 * Math.sin(p * Math.PI * 2));
    const beam = ctx.createLinearGradient(beamX - w * 0.45, 0, beamX + w * 0.45, h);
    beam.addColorStop(0, "rgba(255,255,255,0)");
    beam.addColorStop(0.5, "rgba(255,252,245,0.5)");
    beam.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, w, h);

    // Slow macro push-in.
    const zoom = 1 + p * 0.12;
    const cx = w / 2;
    const cy = h * 0.56;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    // Subtle product rotation expressed as horizontal skew of highlights.
    const rot = Math.sin(p * Math.PI * 2) * 0.05;

    // Surface shadow.
    ctx.fillStyle = "rgba(62,54,46,0.16)";
    ctx.beginPath();
    ctx.ellipse(0, h * 0.165, w * 0.19, h * 0.016, 0, 0, Math.PI * 2);
    ctx.fill();

    // Serum bottle body (frosted glass).
    const bw = w * 0.21;
    const bh = h * 0.26;
    const glass = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
    glass.addColorStop(0, shade(sand, -8));
    glass.addColorStop(0.35 + rot, "#ffffff");
    glass.addColorStop(0.65 + rot, shade(paper, -4));
    glass.addColorStop(1, shade(bronze, 18));
    roundRect(ctx, -bw / 2, -bh * 0.35, bw, bh, bw * 0.18);
    ctx.fillStyle = glass;
    ctx.fill();

    // Liquid line.
    ctx.fillStyle = "rgba(169,143,114,0.35)";
    roundRect(ctx, -bw / 2 + 3, bh * 0.28, bw - 6, bh * 0.32, bw * 0.12);
    ctx.fill();

    // Dropper cap.
    const cw = bw * 0.42;
    ctx.fillStyle = ink;
    roundRect(ctx, -cw / 2, -bh * 0.35 - h * 0.052, cw, h * 0.052, 3);
    ctx.fill();
    ctx.fillStyle = shade(ink, 14);
    roundRect(ctx, -cw * 0.22, -bh * 0.35 - h * 0.052 - h * 0.012, cw * 0.44, h * 0.014, 2);
    ctx.fill();

    // Label.
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, -bw * 0.32, -bh * 0.05, bw * 0.64, bh * 0.34, 2);
    ctx.fill();
    ctx.fillStyle = "rgba(62,54,46,0.75)";
    ctx.fillRect(-bw * 0.2, bh * 0.03, bw * 0.4, 1.2);
    ctx.fillRect(-bw * 0.14, bh * 0.09, bw * 0.28, 1.2);

    ctx.restore();

    // Foreground leaf shadow drifting gently (natural environmental movement).
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = ink;
    const sway = Math.sin(p * Math.PI * 2 + 1.2) * w * 0.02;
    ctx.beginPath();
    ctx.ellipse(w * 0.82 + sway, h * 0.14, w * 0.16, h * 0.05, -0.6, 0, Math.PI * 2);
    ctx.ellipse(w * 0.9 + sway * 1.4, h * 0.24, w * 0.12, h * 0.035, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Film grain, very subtle.
    ctx.save();
    ctx.globalAlpha = 0.028;
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = i % 2 ? "#000" : "#fff";
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Lighten/darken a hex color by `amt` (−100..100). */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + Math.round(2.55 * amt)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `rgb(${r},${g},${b})`;
}
