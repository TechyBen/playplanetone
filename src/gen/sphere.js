// Sphere helpers for planets. Fields live on a domain: a set of cells, each
// knowing its direction, area and neighbours, plus index(x, y, z) to find the
// cell under a direction. Two domains share that shape, so the same steps run
// on either (geodesic is the one in use; the cube map stays for comparison):
//   cube - a cube map, six N×N faces of square texels, four neighbours each.
//   geo  - geodesic cells: the vertices of a subdivided icosphere, each the
//          centre of a hexagon (twelve pentagons), five or six neighbours.
// The render mesh is an icosphere too, subdivided to taste.

export const NB = 6; // neighbour slots per cell; deg[] says how many are used

// Detail setting (cube texels per face edge) -> matching geodesic level, by cell count.
export const geoLevel = N => Math.max(2, Math.min(7, Math.round(Math.log((6 * N * N - 2) / 10) / Math.log(4))));

export function getDomain(proj, N) {
  return proj === 'geo' ? getGeo(geoLevel(N)) : getCube(N);
}

// Face f, face coordinates a, b in [-1, 1] -> direction (not normalised).
export function faceDir(f, a, b) {
  switch (f) {
    case 0: return [1, b, -a];
    case 1: return [-1, b, a];
    case 2: return [a, 1, -b];
    case 3: return [a, -1, b];
    case 4: return [a, b, 1];
    default: return [-a, b, -1];
  }
}

// Direction (any length) -> texel index. The inverse of faceDir.
export function cubeIndex(x, y, z, N) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f, a, b;
  if (ax >= ay && ax >= az) { if (x > 0) { f = 0; a = -z / ax; } else { f = 1; a = z / ax; } b = y / ax; }
  else if (ay >= az) { if (y > 0) { f = 2; b = -z / ay; } else { f = 3; b = z / ay; } a = x / ay; }
  else { if (z > 0) { f = 4; a = x / az; } else { f = 5; a = -x / az; } b = y / az; }
  let i = ((a + 1) * 0.5 * N) | 0, j = ((b + 1) * 0.5 * N) | 0;
  if (i >= N) i = N - 1; else if (i < 0) i = 0;
  if (j >= N) j = N - 1; else if (j < 0) j = 0;
  return f * N * N + j * N + i;
}

const cubes = new Map();
export function getCube(N) {
  if (!cubes.has(N)) cubes.set(N, makeCube(N));
  return cubes.get(N);
}

function makeCube(N) {
  const size = 6 * N * N, dir = new Float32Array(size * 3), area = new Float32Array(size), nbrs = new Int32Array(size * NB), deg = new Uint8Array(size).fill(4);
  const step = 2 / N, offs = [[step, 0], [-step, 0], [0, step], [0, -step]];
  let total = 0;
  for (let f = 0; f < 6; f++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = (i + 0.5) / N * 2 - 1, b = (j + 0.5) / N * 2 - 1, k = f * N * N + j * N + i;
    const [x, y, z] = faceDir(f, a, b), l = Math.hypot(x, y, z);
    dir[k * 3] = x / l; dir[k * 3 + 1] = y / l; dir[k * 3 + 2] = z / l;
    total += area[k] = (1 + a * a + b * b) ** -1.5;
    // Off the face edge, faceDir points into the next face and cubeIndex finds it.
    offs.forEach(([da, db], n) => { nbrs[k * NB + n] = cubeIndex(...faceDir(f, a + da, b + db), N); });
  }
  for (let k = 0; k < size; k++) area[k] /= total;
  return { proj: 'cube', N, size, dir, area, nbrs, deg, label: `${N}² × 6 texels`, index: (x, y, z) => cubeIndex(x, y, z, N) };
}

const geos = new Map();
export function getGeo(level) {
  if (!geos.has(level)) geos.set(level, makeGeo(level));
  return geos.get(level);
}

// Geodesic cells: one per icosphere vertex. Area is a third of each touching
// triangle. Lookup goes through a fine cube-map table of nearest cells, built
// by walking the cell graph uphill in dot product from the last answer.
function makeGeo(level) {
  const ico = icosphere(level), dir = ico.verts, size = dir.length / 3, T = ico.tris;
  const sets = Array.from({ length: size }, () => new Set()), area = new Float32Array(size);
  let total = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
    const ux = dir[b * 3] - dir[a * 3], uy = dir[b * 3 + 1] - dir[a * 3 + 1], uz = dir[b * 3 + 2] - dir[a * 3 + 2];
    const vx = dir[c * 3] - dir[a * 3], vy = dir[c * 3 + 1] - dir[a * 3 + 1], vz = dir[c * 3 + 2] - dir[a * 3 + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    area[a] += ar; area[b] += ar; area[c] += ar; total += 3 * ar;
  }
  for (let k = 0; k < size; k++) area[k] /= total;
  const nbrs = new Int32Array(size * NB).fill(-1), deg = new Uint8Array(size);
  sets.forEach((s, k) => { deg[k] = s.size; [...s].forEach((j, q) => { nbrs[k * NB + q] = j; }); });

  const walk = (x, y, z, k) => {
    for (;;) {
      let best = k, bd = dir[k * 3] * x + dir[k * 3 + 1] * y + dir[k * 3 + 2] * z;
      for (let q = 0; q < deg[k]; q++) {
        const j = nbrs[k * NB + q], d = dir[j * 3] * x + dir[j * 3 + 1] * y + dir[j * 3 + 2] * z;
        if (d > bd) { bd = d; best = j; }
      }
      if (best === k) return k;
      k = best;
    }
  };
  // Table resolution: about four table texels across each cell.
  const L = Math.min(512, 4 * Math.ceil(Math.sqrt(size / 6))), lut = new Int32Array(6 * L * L);
  let k = 0;
  for (let f = 0; f < 6; f++) for (let j = 0; j < L; j++) for (let i = 0; i < L; i++) {
    const [x, y, z] = faceDir(f, (i + 0.5) / L * 2 - 1, (j + 0.5) / L * 2 - 1);
    lut[f * L * L + j * L + i] = k = walk(x, y, z, k);
  }
  return { proj: 'geo', level, N: L, size, dir, area, nbrs, deg, label: `${size.toLocaleString()} cells (level ${level})`, index: (x, y, z) => lut[cubeIndex(x, y, z, L)] };
}

const icos = new Map();
// Unit icosphere: sub 0 = 20 triangles, each level ×4.
export function icosphere(sub) {
  if (icos.has(sub)) return icos.get(sub);
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(p => { const l = Math.hypot(...p); return p.map(c => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = new Map(), next = [];
    const m = (a, b) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (!mid.has(key)) {
        const p = [0, 1, 2].map(c => v[a][c] + v[b][c]), l = Math.hypot(...p);
        mid.set(key, v.push(p.map(c => c / l)) - 1);
      }
      return mid.get(key);
    };
    for (const [a, b, c] of f) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = next;
  }
  const mesh = { verts: Float32Array.from(v.flat()), tris: Uint32Array.from(f.flat()), count: f.length };
  icos.set(sub, mesh);
  return mesh;
}
