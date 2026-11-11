// Garment mesh: maps a flat dress photo onto the tracked body and runs a
// small Verlet cloth simulation so the skirt lags, swings and settles.
//
// Coordinates are camera pixels (un-mirrored). The bodice (shoulders->waist)
// is pinned to the body; below that, vertices are pulled toward their target
// with a spring that gets softer toward the hem, plus distance constraints.

const STEP = 1 / 60;

export class Cloth {
  constructor(cols = 12, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.n = n;
    this.pos = new Float32Array(n * 2);
    this.prev = new Float32Array(n * 2);
    this.target = new Float32Array(n * 2);
    this.uv = new Float32Array(n * 2);
    this.shade = new Float32Array(n).fill(1);
    this.k = new Float32Array(n);       // spring stiffness toward target (1 = pinned)
    this.restV = new Float32Array(n);   // rest length to vertex above
    this.restH = new Float32Array(n);   // rest length to vertex on the right
    this.rowTy = new Float32Array(rows);
    this.ready = false;
    this.acc = 0;

    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        this.uv[v * 2] = i / (cols - 1);
        this.uv[v * 2 + 1] = j / (rows - 1);
      }

    const idx = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    this.indices = new Uint16Array(idx);
  }

  setGarment(imgW, imgH, calib) {
    this.g = {
      w: imgW, h: imgH,
      sY: calib.shoulderY * imgH,
      hY: calib.hipY * imgH,
      cx: ((calib.shoulderL + calib.shoulderR) / 2) * imgW,
      sw: Math.max((calib.shoulderR - calib.shoulderL) * imgW, 1),
    };
    this.g.torso = Math.max(this.g.hY - this.g.sY, 1);
    this.ready = false;
  }

  /** body: {S, H, d, sw, torso, legDir, spread} in camera px */
  computeTargets(body) {
    const { cols, rows, g, target, k } = this;
    const sx = body.sw / g.sw;
    const sy = body.torso / g.torso;
    const [dx, dy] = body.d;
    // the skirt hangs between the leg direction and straight down
    let kx = body.legDir[0] * 0.55, ky = body.legDir[1] * 0.55 + 0.45;
    const kl = Math.hypot(kx, ky) || 1;
    kx /= kl; ky /= kl;

    let cx = 0, cy = 0, prevTy = 0, started = false;
    for (let j = 0; j < rows; j++) {
      const Y = (j / (rows - 1)) * g.h;
      const ty = (Y - g.sY) * sy;
      this.rowTy[j] = ty;
      let dirx, diry, wf = 1;
      if (ty <= body.torso) {
        cx = body.S[0] + dx * ty;
        cy = body.S[1] + dy * ty;
        dirx = dx; diry = dy;
      } else {
        if (!started) { cx = body.H[0]; cy = body.H[1]; prevTy = body.torso; started = true; }
        const t = smooth(0, body.torso * 0.6, ty - body.torso);
        dirx = dx + (kx - dx) * t;
        diry = dy + (ky - dy) * t;
        const l = Math.hypot(dirx, diry) || 1;
        dirx /= l; diry /= l;
        cx += dirx * (ty - prevTy);
        cy += diry * (ty - prevTy);
        prevTy = ty;
        wf = 1 + (body.spread - 1) * 0.6 * t;
      }
      // perpendicular: image +x maps to camera +x when upright
      const px = diry, py = -dirx;
      const free = clamp((ty - body.torso * 0.72) / (body.torso * 1.6), 0, 1);
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        const X = (i / (cols - 1)) * g.w;
        const ox = (X - g.cx) * sx * wf;
        target[v * 2] = cx + px * ox;
        target[v * 2 + 1] = cy + py * ox;
        k[v] = ty < body.torso * 0.72 ? 1 : 0.32 * (1 - free) + 0.022 * free;
      }
    }

    // rest lengths follow the current body scale
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        if (j > 0) this.restV[v] = dist(target, v, v - cols);
        if (i < cols - 1) this.restH[v] = dist(target, v, v + 1);
      }

    if (!this.ready) this.reset();
  }

  reset() {
    this.pos.set(this.target);
    this.prev.set(this.target);
    this.ready = true;
    this.acc = 0;
  }

  update(dt) {
    if (!this.ready) return;
    this.acc = Math.min(this.acc + dt, STEP * 4);
    while (this.acc >= STEP) {
      this.step();
      this.acc -= STEP;
    }
    this.computeShade();
  }

  step() {
    const { pos, prev, target, k, n, cols, rows } = this;
    const damp = 0.9;
    for (let v = 0; v < n; v++) {
      const x = v * 2, y = x + 1;
      if (k[v] >= 1) {
        prev[x] = pos[x] = target[x];
        prev[y] = pos[y] = target[y];
        continue;
      }
      const vx = (pos[x] - prev[x]) * damp;
      const vy = (pos[y] - prev[y]) * damp;
      prev[x] = pos[x]; prev[y] = pos[y];
      pos[x] += vx + (target[x] - pos[x]) * k[v];
      pos[y] += vy + (target[y] - pos[y]) * k[v];
    }
    for (let it = 0; it < 3; it++) {
      for (let j = 1; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const v = j * cols + i;
          this.satisfy(v - cols, v, this.restV[v], 0.92, 1.04, 1);
          if (i < cols - 1) this.satisfy(v, v + 1, this.restH[v], 0.7, 1.08, 0.5);
        }
    }
  }

  // keep distance between a and b within [lo, hi] * rest
  satisfy(a, b, rest, lo, hi, stiff) {
    const p = this.pos;
    const dx = p[b * 2] - p[a * 2], dy = p[b * 2 + 1] - p[a * 2 + 1];
    const d = Math.hypot(dx, dy) || 1e-6;
    let want = d;
    if (d > rest * hi) want = rest * hi;
    else if (d < rest * lo) want = rest * lo;
    else return;
    const wa = this.k[a] >= 1 ? 0 : 1, wb = this.k[b] >= 1 ? 0 : 1;
    if (wa + wb === 0) return;
    const corr = ((d - want) / d) * stiff / (wa + wb);
    p[a * 2] += dx * corr * wa; p[a * 2 + 1] += dy * corr * wa;
    p[b * 2] -= dx * corr * wb; p[b * 2 + 1] -= dy * corr * wb;
  }

  // darken where the fabric is compressed (folds) and where it swings
  computeShade() {
    const { cols, rows, pos, prev } = this;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        const h = i < cols - 1 ? v : v - 1;
        const r = this.restH[h] || 1;
        const c = dist(pos, h, h + 1) / r;
        const sp = Math.hypot(pos[v * 2] - prev[v * 2], pos[v * 2 + 1] - prev[v * 2 + 1]);
        this.shade[v] = clamp(0.62 + 0.4 * c - Math.min(sp * 0.01, 0.06), 0.72, 1.06);
      }
  }
}

function dist(a, i, j) {
  return Math.hypot(a[i * 2] - a[j * 2], a[i * 2 + 1] - a[j * 2 + 1]);
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
