// Draws a world (src/gen/planet.js) PS1 style: a software rasteriser fills
// icosphere triangles at low resolution with a z-buffer, looks each pixel's
// direction up in the world's domain (cube map or geodesic cells), and
// quantises light into the material's pixel-art ramp with a Bayer dither.
// Then a dithered cloud shell and an atmosphere rim.

import { icosphere } from '../gen/sphere.js';
import { WATER } from '../gen/planet.js';
import { mulberry32 } from '../core/rng.js';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(x => (x + 0.5) / 16 - 0.5);
const LIGHT = (() => { const v = [-0.55, 0.45, 0.7], l = Math.hypot(...v); return v.map(c => c / l); })();
const HALF = (() => { const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1], l = Math.hypot(...v); return v.map(c => c / l); })();
const dim = c => (((c & 0xfefefe) >>> 1) | 0xff000000) >>> 0;

const mm = (A, B) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
// planet space -> view space: spin about the axis, axial tilt, then lean the pole towards the viewer.
function viewMatrix(spin, tilt, lean = 0.28) {
  const cy = Math.cos(spin), sy = Math.sin(spin), cz = Math.cos(tilt), sz = Math.sin(tilt), cx = Math.cos(lean), sx = Math.sin(lean);
  return mm([1, 0, 0, 0, cx, -sx, 0, sx, cx], mm([cz, -sz, 0, sz, cz, 0, 0, 0, 1], [cy, 0, sy, 0, 1, 0, -sy, 0, cy]));
}
const tmul = (M, v) => [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];

export const RELIEF = 0.05; // displacement at relief 1, in planet radii

export function drawWorld(canvas, world, o = {}) {
  const { spin = 0, time = 0, sub = 3, relief = 1, faceted = true, clouds = true, atmo = true, bump = 1, wire = false } = o;
  const W = canvas.width, ctx = canvas.getContext('2d');
  let S = canvas._pf;
  if (!S || S.W !== W) S = canvas._pf = { W, img: ctx.createImageData(W, W), z: new Float32Array(W * W) };
  const buf = new Uint32Array(S.img.data.buffer), zb = S.z;
  buf.fill(0xff0e0b0a);
  zb.fill(-1e9);

  const rnd = mulberry32(world.spec.seed ^ 0x5bd1e995);
  for (let k = 0, count = (W * W) / 300; k < count; k++) {
    const g = 60 + ((rnd() * rnd() * 195) | 0);
    buf[(rnd() * W * W) | 0] = (0xff000000 | (g << 16) | (g << 8) | Math.min(255, g + 20)) >>> 0;
  }

  const R = W * 0.36 * world.scale, cx = W / 2, cy = W / 2;
  const Mv = viewMatrix(spin, world.tilt), LP = tmul(Mv, LIGHT), HP = tmul(Mv, HALF);
  const { mat, tone, mat2, tone2, blend, grad, disp, ramps, dom } = world, index = dom.index;
  const mesh = icosphere(sub), V = mesh.verts, nv = V.length / 3;
  const flow = world.flow, cflow = world.cloudFlow;

  // Flowing layers (gas bands, clouds) turn about the axis at a speed set by latitude.
  const lookup = (x, y, z, f) => {
    if (f) {
      const a = time * (f.base + f.amp * Math.sin(y * f.freq * Math.PI)), c = Math.cos(a), s = Math.sin(a);
      return index(x * c + z * s, y, -x * s + z * c);
    }
    return index(x, y, z);
  };

  const proj = (radius) => {
    const P = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const x = V[v * 3], y = V[v * 3 + 1], z = V[v * 3 + 2], r = radius(x, y, z);
      const px = x * r, py = y * r, pz = z * r;
      P[v * 3] = Mv[0] * px + Mv[1] * py + Mv[2] * pz;
      P[v * 3 + 1] = Mv[3] * px + Mv[4] * py + Mv[5] * pz;
      P[v * 3 + 2] = Mv[6] * px + Mv[7] * py + Mv[8] * pz;
    }
    return P;
  };

  // Rasterise every front-facing triangle; shade(px, d, lamF, k) fills pixel k.
  const raster = (P, shade, depthOnlyFront) => {
    const T = mesh.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t], b = T[t + 1], c = T[t + 2];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], qx = P[c * 3], qy = P[c * 3 + 1], qz = P[c * 3 + 2];
      let nx = (by - ay) * (qz - az) - (bz - az) * (qy - ay), ny = (bz - az) * (qx - ax) - (bx - ax) * (qz - az), nz = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (nx * (ax + bx + qx) + ny * (ay + by + qy) + nz * (az + bz + qz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
      if (nz <= 0) continue;
      const nl = Math.hypot(nx, ny, nz), lamF = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl;
      const X0 = cx + R * ax, Y0 = cy - R * ay, X1 = cx + R * bx, Y1 = cy - R * by, X2 = cx + R * qx, Y2 = cy - R * qy;
      const area = (X1 - X0) * (Y2 - Y0) - (Y1 - Y0) * (X2 - X0);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(X0, X1, X2))), maxX = Math.min(W - 1, Math.ceil(Math.max(X0, X1, X2)));
      const minY = Math.max(0, Math.floor(Math.min(Y0, Y1, Y2))), maxY = Math.min(W - 1, Math.ceil(Math.max(Y0, Y1, Y2)));
      for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5, sy = py + 0.5;
        const w0 = ((X2 - X1) * (sy - Y1) - (Y2 - Y1) * (sx - X1)) / area;
        const w1 = ((X0 - X2) * (sy - Y2) - (Y0 - Y2) * (sx - X2)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const k = py * W + px, zz = w0 * az + w1 * bz + w2 * qz;
        if (zz <= zb[k]) continue;
        // Interpolate the unit directions (planet space) for the texel lookup.
        let dx = w0 * V[a * 3] + w1 * V[b * 3] + w2 * V[c * 3], dy = w0 * V[a * 3 + 1] + w1 * V[b * 3 + 1] + w2 * V[c * 3 + 1], dz = w0 * V[a * 3 + 2] + w1 * V[b * 3 + 2] + w2 * V[c * 3 + 2];
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        if (shade(px, py, k, dx, dy, dz, lamF)) { if (!depthOnlyFront) zb[k] = zz; }
      }
    }
  };

  // Surface.
  const r0 = world.spec.type === 'gas' ? () => 1 : (x, y, z) => 1 + relief * RELIEF * disp[index(x, y, z)];
  raster(proj(r0), (px, py, k, x, y, z, lamF) => {
    const i = lookup(x, y, z, flow), d = BAYER[(py & 3) * 4 + (px & 3)];
    // Partial ice: dither between the ground and the ice by coverage.
    const top = blend[i] > 0.5 + d, m = top ? mat2[i] : mat[i];
    let lam = faceted ? lamF : x * LP[0] + y * LP[1] + z * LP[2];
    lam -= bump * 0.6 * (grad[i * 3] * LP[0] + grad[i * 3 + 1] * LP[1] + grad[i * 3 + 2] * LP[2]);
    let step = Math.round((top ? tone2[i] : tone[i]) * 2.4 + lam * 3.4 - 1.1 + d * 0.95);
    if (WATER.has(m) && x * HP[0] + y * HP[1] + z * HP[2] > 0.985 + d * 0.01) step = 5;
    step = step < 0 ? 0 : step > 5 ? 5 : step;
    const col = ramps[m][step];
    buf[k] = lam < 0.04 + d * 0.06 ? dim(dim(col)) : lam < 0.12 + d * 0.06 ? dim(col) : col;
    return true;
  });

  if (wire) {
    const P = proj(r0), T = mesh.tris;
    ctx.putImageData(S.img, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.5; ctx.beginPath();
    for (let t = 0; t < T.length; t += 3) {
      const [a, b, c] = [T[t], T[t + 1], T[t + 2]];
      if (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2] < 0) continue;
      ctx.moveTo(cx + R * P[a * 3], cy - R * P[a * 3 + 1]); ctx.lineTo(cx + R * P[b * 3], cy - R * P[b * 3 + 1]);
      ctx.lineTo(cx + R * P[c * 3], cy - R * P[c * 3 + 1]); ctx.closePath();
    }
    ctx.stroke();
    return;
  }

  // Cloud shell: screen-door transparency for thin cloud, like PS1 alpha.
  if (clouds && world.cloud) {
    const rc = 1 + relief * RELIEF + 0.02, cl = world.cloud, cr = world.cloudRamp;
    raster(proj(() => rc), (px, py, k, x, y, z) => {
      const dens = cl[lookup(x, y, z, cflow)], d = BAYER[(py & 3) * 4 + (px & 3)];
      if (dens < 0.5 + d * 0.5) return false;
      if (dens < 0.8 && ((px ^ py) & 1)) return false;
      const lam = x * LP[0] + y * LP[1] + z * LP[2];
      const step = Math.max(0, Math.min(3, Math.round(lam * 3.5 + 0.6 + d)));
      buf[k] = lam < 0.04 ? dim(dim(cr[step])) : lam < 0.12 ? dim(cr[step]) : cr[step];
      return true;
    }, true);
  }

  // Atmosphere: a rim inside the disc and a glow outside it, lit side brighter, in four dithered levels.
  if (atmo && world.atmo.depth > 0) {
    const depth = world.atmo.depth, [ar, ag, ab] = world.atmo.rgb, outer = R * (1 + depth) + 1;
    const lx = LIGHT[0], ly = LIGHT[1], ll = Math.hypot(lx, ly);
    for (let py = Math.max(0, Math.floor(cy - outer)); py <= Math.min(W - 1, Math.ceil(cy + outer)); py++) {
      for (let px = Math.max(0, Math.floor(cx - outer)); px <= Math.min(W - 1, Math.ceil(cx + outer)); px++) {
        const dx = (px + 0.5 - cx) / R, dy = (cy - py - 0.5) / R, rho = Math.hypot(dx, dy);
        if (rho > 1 + depth || rho < 1 - depth) continue;
        const k = py * W + px, side = (dx * lx + dy * ly) / (rho * ll || 1), lit = 0.25 + 0.75 * Math.max(0, (side + 0.35) / 1.35);
        let a = rho >= 1 ? (1 - (rho - 1) / depth) ** 2 * 0.85 : ((rho - (1 - depth)) / depth) ** 2 * 0.5;
        if (rho >= 1 && zb[k] > -1e8) a *= 0.5; // terrain poking above the rim
        a = Math.floor((a * lit) * 4 + BAYER[(py & 3) * 4 + (px & 3)] + 0.5) / 4;
        if (a <= 0) continue;
        const c = buf[k], r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
        buf[k] = (0xff000000 | (Math.round(b + (ab - b) * a) << 16) | (Math.round(g + (ag - g) * a) << 8) | Math.round(r + (ar - r) * a)) >>> 0;
      }
    }
  }
  ctx.putImageData(S.img, 0, 0);
}
