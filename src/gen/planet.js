// Planet and moon generation. No DOM.
//
// A world is rolled as a spec (type, subtype, size and a constructor of heat,
// activity, atmosphere, water and life), then built: the constructor picks an
// order of geological steps, each step works on layers sampled on a domain
// (cube map or geodesic cells): height, lava, ice, sand, desert, grass, forest,
// canyon. A final paint turns the layers into a material and tone per cell.
// Colours come from the pixel-art ramps in colour.js.
//
// Gas giants skip the layers: latitude bands, warped and twisted by storms,
// with flow added at render time. Moons roll from their own muted families, or
// take a parent planet's data and mute it.

import { Rng } from '../core/rng.js';
import { fbm3, ridged3, hash3 } from '../core/noise3.js';
import { getDomain, NB } from './sphere.js';
import { ramp, hsl } from '../core/colour.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const MATERIALS = ['deep', 'shallow', 'sea ice', 'sand', 'desert', 'dirt', 'grass', 'forest', 'rock', 'strata', 'ice', 'lava', 'zone', 'belt', 'storm', 'snow'];
const M = Object.fromEntries(MATERIALS.map((m, i) => [m, i]));
export const WATER = new Set([M.deep, M.shallow]);

// Level-layout category for each material: the "% influence" on the level.
export const MIX_OF = {
  deep: 'open sea', shallow: 'shallows', 'sea ice': 'ice', sand: 'beaches', desert: 'desert', dirt: 'plains', grass: 'plains',
  forest: 'forest', rock: 'mountains', strata: 'canyons', ice: 'ice', lava: 'lava', zone: 'open sky', belt: 'open sky', storm: 'storms', snow: 'mountains',
};

// ---- tables ---------------------------------------------------------------

// Constructor ranges per subtype. `force` keeps a step through the size budget.
export const SUBTYPES = {
  rock: {
    desert: { heat: [0.6, 0.9], activity: [0.1, 0.5], atmo: [0.25, 0.6], water: [0, 0.08], life: [0, 0.15] },
    ice: { heat: [0, 0.18], activity: [0.1, 0.5], atmo: [0.2, 0.6], water: [0.1, 0.35], life: [0, 0.1] },
    forest: { heat: [0.42, 0.62], activity: [0.2, 0.5], atmo: [0.65, 0.9], water: [0.2, 0.4], life: [0.75, 1], force: ['life'] },
    canyon: { heat: [0.45, 0.75], activity: [0.5, 0.8], atmo: [0.35, 0.65], water: [0.02, 0.12], life: [0, 0.3], force: ['canyons'] },
    mountain: { heat: [0.3, 0.55], activity: [0.75, 1], atmo: [0.4, 0.8], water: [0.12, 0.3], life: [0.2, 0.6], force: ['mountains'] },
    ember: { heat: [0.86, 1], activity: [0.75, 1], atmo: [0.1, 0.45], water: [0, 0], life: [0, 0], force: ['volcanism'] },
  },
  water: {
    ocean: { heat: [0.35, 0.65], activity: [0.2, 0.6], atmo: [0.6, 0.9], water: [0.9, 0.97], life: [0.3, 0.8] },
    archipelago: { heat: [0.5, 0.75], activity: [0.55, 0.9], atmo: [0.6, 0.9], water: [0.78, 0.88], life: [0.5, 0.9] },
    continents: { heat: [0.38, 0.62], activity: [0.35, 0.7], atmo: [0.6, 0.9], water: [0.55, 0.7], life: [0.5, 0.95] },
    shallows: { heat: [0.55, 0.8], activity: [0.1, 0.35], atmo: [0.5, 0.8], water: [0.6, 0.85], life: [0.3, 0.7], shallow: 0.1 },
  },
  gas: {
    banded: { bands: [6, 10], warp: [0.08, 0.16], storms: [1, 3], twist: [1.5, 3], family: 'tan' },
    stormy: { bands: [5, 9], warp: [0.16, 0.28], storms: [4, 9], twist: [2.5, 5], family: 'any' },
    haze: { bands: [3, 6], warp: [0.04, 0.1], storms: [0, 1], twist: [1, 2], family: 'cool', contrast: 0.55 },
    hot: { bands: [6, 12], warp: [0.1, 0.2], storms: [1, 4], twist: [2, 4], family: 'hot' },
  },
};

// Moons: mostly rocky and dry, with ice and cold-water options. `w` is the roll weight.
export const MOON_SUBTYPES = {
  grey: { w: 3, heat: [0.15, 0.4], activity: [0, 0.25], atmo: [0, 0.1], water: [0, 0] },
  clay: { w: 2, heat: [0.3, 0.55], activity: [0.1, 0.35], atmo: [0, 0.2], water: [0, 0.05] },
  dust: { w: 2, heat: [0.45, 0.7], activity: [0, 0.3], atmo: [0.05, 0.25], water: [0, 0] },
  ember: { w: 1, heat: [0.86, 1], activity: [0.7, 1], atmo: [0, 0.15], water: [0, 0], force: ['volcanism'] },
  ice: { w: 2, heat: [0, 0.1], activity: [0.3, 0.6], atmo: [0, 0.15], water: [0.3, 0.6], cracks: true, force: ['plates'] },
  'cold water': { w: 1, heat: [0.12, 0.25], activity: [0.1, 0.4], atmo: [0.1, 0.3], water: [0.6, 0.85] },
};

// ---- rolls ----------------------------------------------------------------

// Type roll: a weighted bias against repeats, not a hard gate.
export const TYPE_BASE = { rock: 1, water: 1, gas: 1 };
export const REPEAT_DAMP = [0.3, 0.6]; // last world, the one before
export function typeWeights(history) {
  const w = { ...TYPE_BASE }, last = history.at(-1), prev = history.at(-2);
  if (last) w[last] *= REPEAT_DAMP[0];
  if (prev) w[prev] *= REPEAT_DAMP[1];
  return w;
}

// Separate streams, so fixing the type or subtype doesn't shift the other rolls.
const stream = (seed, k) => new Rng((seed ^ Math.imul(k, 0x9e3779b1)) >>> 0);
export const newSeed = () => (Math.random() * 4294967296) >>> 0;

export function rollSpec({ kind = 'planet', type, subtype, seed = newSeed(), history = [] } = {}) {
  let weights = null;
  if (kind === 'moon') type = 'rock';
  else if (!SUBTYPES[type]) { weights = typeWeights(history); type = stream(seed, 1).weighted(weights); }
  const table = kind === 'moon' ? MOON_SUBTYPES : SUBTYPES[type];
  if (!table[subtype]) {
    subtype = kind === 'moon'
      ? stream(seed, 2).weighted(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.w])))
      : stream(seed, 2).pick(Object.keys(table));
  }
  const t = table[subtype], rng = stream(seed, 3);
  const size = kind === 'moon' ? 0 : +rng.weighted({ 0: 1, 1: 2, 2: 1.2 });
  const c = {};
  for (const k of ['heat', 'activity', 'atmo', 'water', 'life']) c[k] = t[k] ? rng.range(t[k]) : 0;
  const g = type === 'gas' ? { bands: rng.irange(t.bands), warp: rng.range(t.warp), storms: rng.irange(t.storms), twist: rng.range(t.twist) } : null;
  return { kind, type, subtype, seed, size, c, g, tilt: rng.float(-0.4, 0.4), weights };
}

// A moon built from a planet's data, muted: colder, calmer, thinner air, less
// water, no life, and the parent's palette softened. A gas giant has no surface
// to copy, so its moon rolls a moon family tinted towards the parent's colours.
export function moonOf(parent, seed = newSeed()) {
  const ref = { kind: 'planet', seed: parent.seed, type: parent.type, subtype: parent.subtype };
  if (parent.type === 'gas') return { ...rollSpec({ kind: 'moon', seed }), parent: ref };
  const rng = stream(seed, 4), p = parent.c;
  return {
    kind: 'moon', type: 'rock', subtype: parent.subtype, seed, size: 0, parent: ref, muted: true,
    c: { heat: p.heat * rng.float(0.6, 0.85), activity: p.activity * 0.5, atmo: p.atmo * 0.25, water: p.water * 0.5, life: 0 },
    g: null, tilt: rng.float(-0.4, 0.4), weights: null,
  };
}

const tableOf = spec => (spec.kind === 'moon' && !spec.muted ? MOON_SUBTYPES : SUBTYPES[spec.muted ? spec.parent.type : spec.type])?.[spec.subtype] ?? {};
export const label = spec => spec.kind === 'moon'
  ? (spec.muted ? `${spec.subtype} moon (muted)` : `${spec.subtype} moon`)
  : `${spec.subtype} ${spec.type === 'gas' ? 'gas giant' : spec.type === 'water' ? 'water world' : 'rock world'}`;

// ---- palettes -------------------------------------------------------------

// [hue range, saturation range, lightness range] per material.
const BASE = {
  deep: [[205, 232], [0.45, 0.65], [0.2, 0.28]], shallow: [[172, 198], [0.4, 0.58], [0.4, 0.5]], 'sea ice': [[190, 210], [0.12, 0.25], [0.82, 0.9]],
  sand: [[36, 48], [0.35, 0.5], [0.62, 0.72]], desert: [[18, 38], [0.4, 0.58], [0.48, 0.6]], dirt: [[24, 40], [0.22, 0.38], [0.36, 0.46]],
  grass: [[78, 118], [0.35, 0.55], [0.38, 0.48]], forest: [[100, 150], [0.32, 0.5], [0.22, 0.3]], rock: [[18, 40], [0.06, 0.18], [0.4, 0.52]],
  strata: [[8, 28], [0.42, 0.6], [0.44, 0.55]], ice: [[188, 212], [0.12, 0.28], [0.84, 0.92]], lava: [[6, 24], [0.85, 1], [0.5, 0.58]],
};

// Moon colour families: muted options that differ from planets.
const FAMILY = {
  grey: { dirt: [[0, 360], [0, 0.06], [0.42, 0.52]], rock: [[0, 360], [0, 0.05], [0.55, 0.65]], strata: [[20, 40], [0.05, 0.12], [0.3, 0.38]] },
  clay: { dirt: [[12, 26], [0.25, 0.38], [0.42, 0.5]], rock: [[14, 28], [0.15, 0.25], [0.52, 0.6]], strata: [[5, 18], [0.3, 0.42], [0.34, 0.42]] },
  dust: { dirt: [[36, 50], [0.15, 0.28], [0.58, 0.66]], rock: [[30, 45], [0.1, 0.18], [0.66, 0.74]], strata: [[25, 40], [0.2, 0.3], [0.48, 0.56]] },
  ember: { dirt: [[10, 25], [0.06, 0.12], [0.18, 0.24]], rock: [[0, 20], [0.04, 0.1], [0.28, 0.34]], lava: [[8, 20], [0.65, 0.8], [0.45, 0.52]], strata: [[0, 15], [0.2, 0.3], [0.22, 0.28]] },
  ice: { ice: [[185, 215], [0.1, 0.22], [0.8, 0.88]], 'sea ice': [[185, 210], [0.12, 0.25], [0.85, 0.92]], strata: [[15, 30], [0.3, 0.45], [0.42, 0.5]], dirt: [[200, 220], [0.08, 0.15], [0.6, 0.7]], rock: [[200, 220], [0.06, 0.12], [0.7, 0.78]] },
  'cold water': { deep: [[182, 200], [0.3, 0.42], [0.16, 0.22]], shallow: [[178, 195], [0.25, 0.35], [0.28, 0.36]], dirt: [[200, 230], [0.05, 0.12], [0.4, 0.48]], rock: [[200, 230], [0.04, 0.1], [0.52, 0.6]] },
};

const GAS = {
  tan: { zone: [[35, 48], [0.3, 0.42], [0.68, 0.76]], belt: [[18, 34], [0.4, 0.52], [0.42, 0.52]], storm: [[2, 18], [0.5, 0.65], [0.5, 0.58]] },
  cool: { zone: [[172, 200], [0.25, 0.35], [0.68, 0.76]], belt: [[190, 220], [0.3, 0.42], [0.5, 0.58]], storm: [[205, 230], [0.35, 0.45], [0.4, 0.5]] },
  hot: { zone: [[24, 40], [0.6, 0.75], [0.58, 0.66]], belt: [[0, 18], [0.6, 0.72], [0.38, 0.46]], storm: [[40, 56], [0.7, 0.85], [0.66, 0.74]] },
};

const roll = (rng, [h, s, l]) => ({ h: rng.range(h), s: rng.range(s), l: rng.range(l), c: 1 });
const hueMix = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };

function rollPalettes(spec) {
  // A muted moon re-rolls its parent's palette, so it keeps the parent's colours.
  const src = spec.muted ? spec.parent : spec;
  const rng = stream(src.seed, 5), P = {};
  for (const [m, r] of Object.entries(BASE)) P[m] = roll(rng, r);

  if (spec.type === 'gas') {
    const t = SUBTYPES.gas[spec.subtype];
    if (t.family === 'any') {
      const H = rng.float(0, 360);
      P.zone = { h: H + rng.float(-10, 10), s: rng.float(0.28, 0.4), l: rng.float(0.66, 0.74), c: 1 };
      P.belt = { h: H + rng.float(20, 40), s: rng.float(0.38, 0.5), l: rng.float(0.44, 0.52), c: 1 };
      P.storm = { h: H + rng.pick([-1, 1]) * rng.float(25, 60), s: rng.float(0.45, 0.6), l: rng.float(0.5, 0.6), c: 1 };
    } else for (const [m, r] of Object.entries(GAS[t.family])) P[m] = roll(rng, r);
    if (t.contrast) for (const m of ['zone', 'belt', 'storm']) P[m].c = t.contrast;
    return P;
  }

  const sub = src.subtype;
  if (src.kind === 'planet') {
    if (sub === 'desert' && rng.chance(0.4)) { // rust worlds
      P.dirt.h = rng.float(8, 20); P.dirt.s = 0.45; P.desert.h = rng.float(6, 18); P.rock.h = rng.float(10, 20); P.rock.s = 0.25;
    }
    if (sub === 'ice') { P.grass.s *= 0.6; P.forest.s *= 0.6; P.rock.l += 0.05; }
    if (sub === 'ember') {
      P.rock = { h: rng.float(0, 30), s: rng.float(0.05, 0.12), l: rng.float(0.14, 0.22), c: 1 };
      P.dirt = { h: rng.float(10, 30), s: 0.1, l: rng.float(0.2, 0.26), c: 1 };
      P.desert = { ...P.dirt, l: P.dirt.l + 0.04 };
      P.strata = { h: rng.float(0, 15), s: 0.35, l: 0.3, c: 1 };
    }
    if (sub === 'forest') { P.grass.s += 0.1; P.forest.s += 0.08; }
    if (sub === 'archipelago' || sub === 'shallows') { P.shallow.h = rng.float(168, 182); P.shallow.s += 0.08; P.shallow.l += 0.05; }
    if (rng.chance(0.12)) { const d = rng.pick([150, 200, 250]); P.grass.h += d; P.forest.h += d; } // alien plant life
    if (rng.chance(0.08)) { const d = rng.pick([-60, 60, 120]); P.deep.h += d; P.shallow.h += d; } // unusual seas
  } else {
    const fam = FAMILY[sub] ?? FAMILY.grey;
    for (const [m, r] of Object.entries(fam)) P[m] = roll(rng, r);
    P.sand = { ...P.dirt, l: P.dirt.l + 0.08 };
    P.desert = { ...P.dirt, l: P.dirt.l + 0.04 };
    if (spec.parent?.type === 'gas') { // tint towards the parent giant's bands
      const zone = rollPalettes(rollSpec({ kind: 'planet', type: 'gas', subtype: spec.parent.subtype, seed: spec.parent.seed })).zone;
      for (const m of ['dirt', 'rock', 'sand', 'desert']) { P[m].h = hueMix(P[m].h, zone.h, 0.5); P[m].s = Math.max(P[m].s, 0.12); }
    }
  }

  P.snow = { ...P.ice, s: P.ice.s * 0.6, l: Math.min(0.94, P.ice.l + 0.04) };
  if (spec.muted) for (const p of Object.values(P)) { p.s *= 0.55; p.l = lerp(p.l, 0.5, 0.2); p.c = 0.75; }
  return P;
}

function atmosphere(spec, P) {
  const t = spec.type, sub = spec.subtype;
  let h = 205, s = 0.6, l = 0.66;
  if (t === 'gas') { h = P.zone.h; s = 0.35; l = 0.75; }
  else if (sub === 'desert' || sub === 'canyon' || sub === 'dust' || sub === 'clay') { h = 28; s = 0.5; l = 0.66; }
  else if (sub === 'ember') { h = 12; s = 0.7; l = 0.5; }
  else if (sub === 'ice' || sub === 'cold water') { h = 192; s = 0.3; l = 0.8; }
  else if (sub === 'grey') { h = 220; s = 0.08; l = 0.75; }
  let depth = t === 'gas' ? 0.13 : 0.025 + spec.c.atmo * 0.11;
  if (spec.kind === 'moon') depth *= 0.35; // very low atmosphere: not as deep
  return { h, s, l, rgb: hsl(h, s, l), depth };
}

// ---- geological steps -----------------------------------------------------

// The constructor picks which steps run and in what order. Larger worlds get
// more steps, smaller fewer: the lowest-priority steps drop first.
const BUDGET = [5, 7, 9];

export function planSteps(spec) {
  const { heat, activity, atmo, water, life } = spec.c;
  const force = tableOf(spec).force ?? [];
  const hot = heat > 0.65, cold = heat < 0.3, bleak = atmo < 0.3;
  const erosion = clamp(atmo * (0.3 + water * 1.2));
  const rng = stream(spec.seed, 6);
  const list = [];
  const add = (id, pri, note) => list.push({ id, pri: force.includes(id) ? 99 : pri, note });

  add('crust', 99, 'base continents');
  if (hot && activity > 0.5) add('volcanism', hot ? 7 : 5, 'hot start: volcanism before plates');
  if (activity > 0.3) add('plates', 6, '');
  if (activity > 0.35 || force.includes('mountains')) add('mountains', 7, 'ridged ranges along the plates');
  if (!hot && activity > 0.7) add('volcanism', 5, 'late volcanism');
  const craters = bleak || spec.kind === 'moon';
  const oldCraters = craters && erosion > 0.12 && rng.chance(0.5);
  if (oldCraters) add('craters', bleak ? 9 : 4, 'old craters, worn down by erosion');
  if (cold) add('ice', 9, 'cold start: ice before erosion (glacial valleys)');
  if (erosion > 0.12) add('erosion', 6, '');
  if (!cold && heat < 0.75) add('ice', 6, 'polar caps and high snow');
  if (craters && !oldCraters) add('craters', bleak ? 9 : 4, 'fresh craters');
  if ((activity > 0.45 && water < 0.5 && erosion > 0.08) || force.includes('canyons')) add('canyons', 5, 'rivers cut canyons into uplifted rock');
  if (water > 0) add('seas', 99, '');
  if (water > 0.02 || heat > 0.55) add('sediment', 5, 'beaches and dunes');
  if (life > 0.1 && atmo > 0.35) add('life', 6, 'grass and forest');

  const budget = BUDGET[spec.size] ?? 5, dropped = [];
  while (list.length > budget) {
    let lo = 0;
    list.forEach((s, i) => { if (s.pri <= list[lo].pri) lo = i; });
    dropped.push(...list.splice(lo, 1));
  }
  return { steps: list, dropped, erosion };
}

// Area-weighted height quantile: the level below which `frac` of the surface lies.
function quantile(st, frac) {
  const { h, dom } = st;
  if (!st.order || st.dirty) { st.order = Uint32Array.from(h.keys()).sort((a, b) => h[a] - h[b]); st.dirty = false; }
  let acc = 0;
  for (const k of st.order) { acc += dom.area[k]; if (acc >= frac) return h[k]; }
  return h[st.order[st.order.length - 1]];
}
const datumOf = st => (st.c.water > 0 ? quantile(st, st.c.water) : quantile(st, 0.06));

// Temperature and moisture, 0..1-ish, from heat, latitude, altitude and air.
function climate(st) {
  const { h, dom, c, n, cn } = st, D = dom.dir, datum = datumOf(st);
  const temp = new Float32Array(n), moist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const above = Math.max(0, h[i] - datum), lat = Math.abs(D[i * 3 + 1]);
    temp[i] = c.heat * 1.3 + 0.1 - 0.75 * lat ** 2.2 - 0.8 * above + 0.24 * (cn[i] - 0.5);
    const coast = c.water > 0 ? 1 - smooth(0, 0.2, above) : 0;
    moist[i] = clamp(c.atmo * (0.25 + c.water * 0.9) + 0.9 * (cn[n + i] - 0.5) + coast * 0.25);
  }
  return { temp, moist, datum };
}

function eachNear(st, cx, cy, cz, r, fn) { // every texel within angle r of a centre
  const D = st.dom.dir, cr = Math.cos(r);
  for (let i = 0; i < st.n; i++) {
    const d = D[i * 3] * cx + D[i * 3 + 1] * cy + D[i * 3 + 2] * cz;
    if (d > cr) fn(i, Math.acos(Math.min(1, d)));
  }
}
const randDir = rng => { for (;;) { const x = rng.float(-1, 1), y = rng.float(-1, 1), z = rng.float(-1, 1), l = Math.hypot(x, y, z); if (l > 0.1 && l <= 1) return [x / l, y / l, z / l]; } };

// Plate boundary shapes and their roll weights: straight about 10% of the time.
export const BOUNDARY_SHAPES = { straight: 1, wave: 3, zigzag: 3, 'wave + zigzag': 3 };

// edge: how far (in temperature) the fractal edge reaches either side of the
// freeze line; blend: the soft band where ice coverage goes from 0 to 1.
export const ICE = { edge: 0.3, blend: 0.04 };

const STEPS = {
  crust(st) {
    const { h, dom, s } = st, D = dom.dir;
    for (let i = 0; i < st.n; i++) {
      const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
      const wx = fbm3(x * 2 + 11, y * 2, z * 2, 3, s + 1) - 0.5, wy = fbm3(x * 2, y * 2 + 23, z * 2, 3, s + 2) - 0.5, wz = fbm3(x * 2, y * 2, z * 2 + 37, 3, s + 3) - 0.5;
      h[i] = (fbm3(x * 1.5 + wx, y * 1.5 + wy, z * 1.5 + wz, 6, s + 4) - 0.5) * 1.5;
    }
  },
  plates(st, step) {
    const { h, dom, rng, c, crack, uplift } = st, D = dom.dir;
    const K = rng.int(5, 9 + st.spec.size * 3), pts = [], lift = [];
    for (let k = 0; k < K; k++) { pts.push(randDir(rng)); lift.push((rng.next() - 0.5) * 0.5 * c.activity); }
    // Boundary shape, one roll per world: straight about 10% of the time,
    // otherwise a wave, a zigzag, or both, each pair of plates with its own
    // frequency, phase and size.
    const shape = rng.weighted(BOUNDARY_SHAPES), wave = shape.includes('wave'), zig = shape.includes('zigzag');
    const pair = (a, b, k) => hash3(a, b, k, st.s);
    const cliffs = new Set();
    for (let i = 0; i < st.n; i++) {
      const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
      let b1 = -2, b2 = -2, k1 = 0, k2 = 0;
      for (let k = 0; k < K; k++) {
        const p = pts[k], d = x * p[0] + y * p[1] + z * p[2];
        if (d > b1) { b2 = b1; k2 = k1; b1 = d; k1 = k; } else if (d > b2) { b2 = d; k2 = k; }
      }
      // Frame for the pair, ordered by index so both sides agree: u across the
      // boundary (towards plate a), m its middle, w along it.
      const a = Math.min(k1, k2), b = Math.max(k1, k2), pa = pts[a], pb = pts[b];
      let ux = pa[0] - pb[0], uy = pa[1] - pb[1], uz = pa[2] - pb[2];
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      let mx = pa[0] + pb[0], my = pa[1] + pb[1], mz = pa[2] + pb[2];
      const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
      const wx = uy * mz - uz * my, wy = uz * mx - ux * mz, wz = ux * my - uy * mx;
      const along = Math.atan2(x * wx + y * wy + z * wz, x * mx + y * my + z * mz);
      // Shift the boundary sideways by the shape; that moves ownership and the
      // ridge together. Both shapes read noise along the boundary, so they
      // never repeat: q is the point on the boundary's circle at this angle.
      let off = 0;
      if (wave || zig) {
        const ca = Math.cos(along), sa = Math.sin(along), id = a * K + b;
        const qx = mx * ca + wx * sa, qy = my * ca + wy * sa, qz = mz * ca + wz * sa;
        const envelope = 0.4 + 1.2 * fbm3(qx * 1.5 + id, qy * 1.5, qz * 1.5, 2, st.s + 72); // size varies along the length
        if (wave) { // a meander: smooth noise, a few octaves
          const f = 2 + 3 * pair(a, b, 2);
          off += (0.04 + 0.06 * pair(a, b, 1)) * envelope * (fbm3(qx * f + id * 7.3, qy * f, qz * f, 3, st.s + 70) - 0.5) * 2.5;
        }
        if (zig) { // straight runs between random knots: uneven spacing and heights
          const t = along * (5 + 6 * pair(a, b, 4)) + 3 * (fbm3(qx * 2 + id, qy * 2, qz * 2, 2, st.s + 71) - 0.5);
          const lin = (t, k) => { const k0 = Math.floor(t); return lerp(hash3(k0, id, k, st.s), hash3(k0 + 1, id, k, st.s), t - k0) * 2 - 1; };
          off += (0.02 + 0.04 * pair(a, b, 6)) * envelope * (lin(t, 5) + 0.45 * lin(t * 2.3 + 0.5, 6));
        }
      }
      const side = (x * ux + y * uy + z * uz) - Math.sin(off); // > 0: plate a's side
      const kOwn = side >= 0 ? a : b, kOther = side >= 0 ? b : a;
      const edge = 2 * Math.asin(Math.min(1, Math.abs(side)));
      const ridge = Math.exp(-((edge / 0.07) ** 2));
      crack[i] = Math.max(crack[i], ridge); // full strength: the boundary for colouring
      // Height decays along the boundary's length: strongest at its middle,
      // fading towards its ends, and broken up by low-frequency noise.
      const fade = Math.exp(-((along / 0.5) ** 2)) * smooth(0.3, 0.65, fbm3(x * 3, y * 3, z * 3, 3, st.s + 8));
      const converge = pair(a, b, 7) < 0.6;
      const raise = ridge * fade * c.activity * (converge ? 0.22 : -0.1);
      // Plate heights blend across the boundary, so neighbours meet in a slope
      // (halfway at the line, own height 0.25 rad in). On occasion a pair keeps
      // some of the cliff, narrowing the blend where the fade is strong.
      const cliff = pair(a, b, 9) < 0.2;
      if (cliff && ridge > 0.5) cliffs.add(a * K + b);
      const own = 0.5 + 0.5 * smooth(0, cliff ? lerp(0.25, 0.03, fade) : 0.25, edge);
      h[i] += lift[kOwn] * own + lift[kOther] * (1 - own) + raise;
      uplift[i] = Math.max(uplift[i], ridge * fade);
    }
    step.note = `${K} plates, ${shape} boundaries${cliffs.size ? `, ${cliffs.size} with cliffs` : ''}; ridges where they push together, rifts where they part, fading along their length`;
  },
  mountains(st) {
    const { h, dom, s, c } = st, D = dom.dir;
    for (let i = 0; i < st.n; i++) {
      const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
      h[i] += c.activity * 0.5 * ridged3(x * 2.4, y * 2.4, z * 2.4, 5, s + 9) * (smooth(-0.15, 0.25, h[i]) * 0.7 + st.uplift[i] * 0.6);
    }
  },
  volcanism(st, step) {
    const { h, rng, c, lava } = st, V = 2 + Math.round(c.activity * 5) + st.spec.size;
    for (let v = 0; v < V; v++) {
      const [cx, cy, cz] = randDir(rng), r = rng.float(0.06, 0.15), tall = rng.float(0.2, 0.4);
      eachNear(st, cx, cy, cz, r, (i, a) => {
        const cone = (1 - a / r) ** 2;
        h[i] += tall * cone;
        lava[i] = Math.max(lava[i], smooth(0.45, 0.75, 1 - a / r));
      });
    }
    let note = `${V} volcanoes`;
    if (c.heat > 0.85) {
      st.dirty = true;
      const level = quantile(st, 0.22);
      for (let i = 0; i < st.n; i++) if (h[i] < level) lava[i] = 1;
      note += ', lava lowlands';
    }
    step.note = (step.note ? step.note + ': ' : '') + note;
  },
  craters(st, step) {
    const { h, rng, c } = st;
    const count = Math.round((c.atmo < 0.3 ? 45 : 15) * (st.spec.kind === 'moon' ? 1.3 : 1) * (1 - c.atmo * 0.5));
    for (let k = 0; k < count; k++) {
      const [cx, cy, cz] = randDir(rng), r = 0.03 + 0.2 * rng.next() ** 3, depth = r * 0.7;
      eachNear(st, cx, cy, cz, r * 1.6, (i, a) => {
        const t = a / r;
        h[i] += t < 1 ? -depth * (1 - t * t) : 0;
        h[i] += depth * 0.45 * Math.exp(-(((t - 1) / 0.25) ** 2));
      });
    }
    step.note = `${count} ${step.note}`;
  },
  erosion(st, step) {
    const { h, dom, ice } = st, nb = dom.nbrs, deg = dom.deg, iters = Math.round(4 + st.erosion * 14), tmp = new Float32Array(st.n);
    for (let it = 0; it < iters; it++) {
      tmp.set(h);
      for (let i = 0; i < st.n; i++) {
        let avg = 0;
        for (let q = 0; q < deg[i]; q++) avg += tmp[nb[i * NB + q]];
        avg /= deg[i];
        h[i] = lerp(tmp[i], avg, st.glacial && ice[i] > 0.5 ? 0.55 : 0.3);
      }
    }
    step.note = `${iters} passes${st.glacial ? ', stronger under ice' : ''}`;
  },
  canyons(st) {
    const { h, dom, s, c, canyon } = st, D = dom.dir, datum = datumOf(st);
    for (let i = 0; i < st.n; i++) {
      const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
      const w = fbm3(x * 2 + 5, y * 2, z * 2, 3, s + 12) - 0.5;
      const m = (1 - Math.abs(2 * fbm3(x * 3.2 + w, y * 3.2 - w, z * 3.2 + w, 5, s + 13) - 1)) ** 12;
      if (h[i] > datum + 0.01) { h[i] -= 0.2 * Math.max(0.4, c.activity) * m; canyon[i] = Math.max(canyon[i], m); }
    }
  },
  ice(st) {
    // Dry, airless worlds only frost over where it's very cold.
    const { temp } = climate(st), wet = clamp((st.c.water + st.c.atmo * 0.3) * 4), freeze = 0.1 - (1 - wet) * 0.4;
    // Fractal edge decay: many octaves of noise move the freeze line, so the
    // cap edge breaks into tongues, bays and loose floes that thin out away
    // from it instead of following a clean line of latitude.
    const D = st.dom.dir;
    for (let i = 0; i < st.n; i++) {
      const margin = freeze - temp[i];
      if (margin < -ICE.edge - ICE.blend) continue;
      const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
      const edge = (fbm3(x * 4 + 3, y * 4, z * 4, 6, st.s + 60) - 0.5) * 2 + (fbm3(x * 16, y * 16, z * 16, 3, st.s + 61) - 0.5);
      // Coverage 0..1: a narrow soft band either side of the line, dithered by the renderer.
      st.ice[i] = Math.max(st.ice[i], smooth(-ICE.blend, ICE.blend, margin + ICE.edge * edge));
    }
    if (!st.done.has('erosion')) st.glacial = true;
  },
  seas(st, step) { step.note = `${Math.round(st.c.water * 100)}% of the surface under water`; },
  sediment(st) {
    const { temp, moist, datum } = climate(st);
    for (let i = 0; i < st.n; i++) {
      const above = st.h[i] - datum;
      if (st.c.water > 0.02 && above >= 0 && above < 0.03 + 0.02 * st.cn[i]) st.sand[i] = 1;
      if (temp[i] > 0.5 && moist[i] < 0.32) st.desert[i] = 1;
    }
  },
  life(st) {
    const { temp, moist, datum } = climate(st), L = st.c.life;
    for (let i = 0; i < st.n; i++) {
      const above = st.h[i] - datum, patch = st.cn[2 * st.n + i];
      if (temp[i] > 0.18 && temp[i] < 0.85 && moist[i] > 0.28 && patch < 0.2 + L * 0.8) st.grass[i] = 1;
      if (temp[i] > 0.25 && temp[i] < 0.8 && moist[i] > 0.42 && above < 0.35 && patch < 0.1 + L * 0.7) st.forest[i] = 1;
    }
  },
};

// ---- build ----------------------------------------------------------------

const pack = ([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const SCALE = [0.82, 0.94, 1.06];

export function buildWorld(spec, N = 64, proj = 'geo') {
  const dom = getDomain(proj, N), n = dom.size, D = dom.dir;
  const P = rollPalettes(spec);
  const ramps = MATERIALS.map(m => Uint32Array.from(P[m] ? ramp(P[m].h, P[m].s, P[m].l, P[m].c, 6).map(pack) : new Array(6).fill(0xffff00ff)));
  const atmo = atmosphere(spec, P);
  const cloudRamp = Uint32Array.from(ramp(atmo.h, 0.1, 0.8, 0.7, 4).map(pack));
  const s = spec.seed & 0xffffff;
  const world = { spec, N, dom, ramps, palette: P, atmo, cloudRamp, mat: new Uint8Array(n), tone: new Float32Array(n), mat2: new Uint8Array(n), tone2: new Float32Array(n), blend: new Float32Array(n), grad: new Float32Array(n * 3), disp: new Float32Array(n), cloud: null, flow: null, cloudFlow: null, steps: [], dropped: [] };
  world.scale = spec.kind === 'moon' ? 0.68 : spec.type === 'gas' ? 1.08 : SCALE[spec.size];
  world.tilt = spec.tilt;

  if (spec.type === 'gas') { buildGas(world, s); world.mix = mixOf(world); return world; }

  const st = {
    spec, c: spec.c, dom, n, s, rng: stream(spec.seed, 7), h: new Float32Array(n), dirty: true, done: new Set(),
    lava: new Float32Array(n), ice: new Float32Array(n), sand: new Float32Array(n), desert: new Float32Array(n),
    grass: new Float32Array(n), forest: new Float32Array(n), canyon: new Float32Array(n), crack: new Float32Array(n), uplift: new Float32Array(n),
    cn: new Float32Array(n * 3), glacial: false,
  };
  for (let i = 0; i < n; i++) {
    const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
    st.cn[i] = fbm3(x * 2.5, y * 2.5, z * 2.5, 4, s + 20);
    st.cn[n + i] = fbm3(x * 2 + 9, y * 2, z * 2, 4, s + 21);
    st.cn[2 * n + i] = fbm3(x * 5, y * 5, z * 5, 4, s + 22);
  }
  const plan = planSteps(spec);
  st.erosion = plan.erosion;
  for (const step of plan.steps) {
    const rec = { id: step.id, note: step.note };
    STEPS[step.id](st, rec);
    st.dirty = true;
    st.done.add(step.id);
    world.steps.push(rec);
  }
  world.dropped = plan.dropped.map(d => d.id);
  world.layers = { height: st.h, crack: st.crack, uplift: st.uplift, ice: st.ice }; // for debug views
  paint(world, st);
  clouds(world, s);
  world.mix = mixOf(world);
  return world;
}

function paint(world, st) {
  const { h, n, dom, c, spec } = st, D = dom.dir, s = st.s;
  const hasSea = c.water > 0.001, datum = datumOf(st);
  // Mountains: the highest share of the land, more with tectonic activity.
  const land = hasSea ? c.water : 0, share = 0.05 + 0.4 * c.activity ** 1.5;
  const mountLevel = Math.max(datum + 0.12, quantile(st, land + (1 - land) * (1 - share)));
  const shallowDepth = tableOf(spec).shallow ?? 0.035;
  const cracks = !!tableOf(spec).cracks;
  const base = hasSea ? datum : quantile(st, 0);
  const hd = new Float32Array(n);
  let top = 1e-6;
  for (let i = 0; i < n; i++) { hd[i] = Math.max(h[i], hasSea ? datum : -Infinity); top = Math.max(top, hd[i] - base); }

  for (let i = 0; i < n; i++) {
    const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
    const above = h[i] - datum, speck = fbm3(x * 14, y * 14, z * 14, 3, s + 30);
    let m, tone = 0.5 + (speck - 0.5) * 0.6;
    // Ice is a second material over the ground, with coverage 0..1; lava and
    // ice-moon cracks stay bare.
    let ice = st.ice[i], m2 = h[i] > mountLevel ? M.snow : M.ice;
    if (hasSea && above < 0) {
      m = -above < shallowDepth ? M.shallow : M.deep; tone = 0.2 + 0.7 * (1 - clamp(-above / 0.3)) + (speck - 0.5) * 0.15;
      m2 = M['sea ice'];
    } else if (st.lava[i] > 0.5) { m = M.lava; tone = 0.45 + speck * 0.5; ice = 0; }
    else if (cracks && st.crack[i] > 0.55) { m = M.strata; ice = 0; }
    else if (st.canyon[i] > 0.35) { m = M.strata; tone = 0.5 + 0.4 * Math.sin(h[i] * 90 + speck * 3); }
    else if (h[i] > mountLevel) { m = M.rock; tone += (h[i] - mountLevel) * 0.8; }
    else if (st.forest[i]) { m = M.forest; tone = 0.35 + 0.6 * hash3(i, 1, 2, s); } // speckle reads as tree clumps
    else if (st.grass[i]) m = M.grass;
    else if (st.desert[i]) { m = M.desert; tone = 0.5 + 0.35 * Math.sin((x * 0.8 + z * 0.6) * 70 + speck * 8); }
    else if (st.sand[i]) m = M.sand;
    else m = M.dirt;
    world.mat[i] = m;
    world.tone[i] = clamp(tone);
    if (ice > 0) {
      world.mat2[i] = m2;
      world.blend[i] = ice;
      world.tone2[i] = clamp(0.55 + (speck - 0.5) * 0.5 + (m2 === M.snow ? 0.15 : 0));
    }
    world.disp[i] = (hd[i] - base) / top;
  }

  // Surface slope per texel (3D, in planet space), so the renderer can light
  // relief finer than the mesh: n' = n - grad.
  const nb = dom.nbrs, G = world.grad;
  for (let i = 0; i < n; i++) {
    let gx = 0, gy = 0, gz = 0;
    const dg = dom.deg[i];
    for (let k = 0; k < dg; k++) {
      const j = nb[i * NB + k];
      const dx = D[j * 3] - D[i * 3], dy = D[j * 3 + 1] - D[i * 3 + 1], dz = D[j * 3 + 2] - D[i * 3 + 2], l2 = dx * dx + dy * dy + dz * dz || 1;
      const dh = (hd[j] - hd[i]) / l2;
      gx += dh * dx; gy += dh * dy; gz += dh * dz;
    }
    G[i * 3] = gx * 2 / dg; G[i * 3 + 1] = gy * 2 / dg; G[i * 3 + 2] = gz * 2 / dg;
  }
}

function clouds(world, s) {
  const { spec, dom } = world, c = spec.c, D = dom.dir, n = dom.size;
  const cover = spec.kind === 'moon' ? c.atmo * 0.6 : c.atmo * (0.2 + c.water * 0.6);
  if (cover < 0.03) return;
  const thr = lerp(0.72, 0.42, clamp(cover)), cl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2];
    const w = fbm3(x * 2 + 3, y * 2, z * 2, 3, s + 40) - 0.5;
    const band = 0.8 + 0.2 * Math.cos(Math.asin(y) * 6);
    cl[i] = smooth(thr, thr + 0.15, fbm3(x * 2.4 + w, y * 4 + w, z * 2.4 - w, 5, s + 41) * band);
  }
  world.cloud = cl;
  world.cloudFlow = { base: 0.05, amp: 0.05, freq: 3 };
}

function buildGas(world, s) {
  const { spec, dom } = world, g = spec.g, D = dom.dir, n = dom.size, rng = stream(spec.seed, 8);
  const vortices = [];
  for (let k = 0; k < g.storms + spec.size; k++) {
    const d = randDir(rng);
    d[1] *= 0.6; const l = Math.hypot(...d);
    vortices.push({ c: d.map(v => v / l), r: rng.float(0.16, 0.34) * (k === 0 ? 1.4 : 1), twist: g.twist * 1.5 * rng.pick([-1, 1]) });
  }
  const waves = [];
  for (let k = 0; k < 4; k++) waves.push({ f: g.bands * rng.float(0.6, 1.6), p: rng.float(0, Math.PI * 2), a: rng.float(0.4, 1) / (k + 1) });
  const ampSum = waves.reduce((t, w) => t + w.a, 0);

  for (let i = 0; i < n; i++) {
    let x = D[i * 3], y = D[i * 3 + 1], z = D[i * 3 + 2], storm = 0;
    for (const v of vortices) { // swirl: rotate the lookup about the storm centre
      const [cx, cy, cz] = v.c, d = x * cx + y * cy + z * cz;
      if (d <= Math.cos(v.r)) continue;
      const a = Math.acos(Math.min(1, d)), t = 1 - a / v.r, ang = v.twist * t * t;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const kx = cy * z - cz * y, ky = cz * x - cx * z, kz = cx * y - cy * x;
      x = x * cs + kx * sn + cx * d * (1 - cs); y = y * cs + ky * sn + cy * d * (1 - cs); z = z * cs + kz * sn + cz * d * (1 - cs);
      storm = Math.max(storm, smooth(0.45, 0.8, t));
    }
    const lat = Math.asin(clamp(y, -1, 1)) + g.warp * 2 * (fbm3(x * 3, y * 6, z * 3, 4, s + 50) - 0.5);
    let b = 0;
    for (const w of waves) b += w.a * Math.sin(lat * w.f + w.p);
    b = 0.5 + 0.5 * b / ampSum;
    const streak = fbm3(x * 10, y * 40, z * 10, 2, s + 51) - 0.5;
    let m, tone;
    if (storm > 0.25) { m = M.storm; tone = storm * 0.8 + streak; }
    else if (b > 0.5) { m = M.zone; tone = (b - 0.5) * 2 + streak * 0.4; }
    else { m = M.belt; tone = b * 2 + streak * 0.4; }
    world.mat[i] = m;
    world.tone[i] = clamp(tone);
  }
  world.steps = [
    { id: 'bands', note: `${g.bands} bands` },
    { id: 'shear', note: `warp ${g.warp.toFixed(2)}` },
    { id: 'storms', note: `${vortices.length} storms` },
    { id: 'flow', note: 'bands drift at different speeds' },
  ];
  world.flow = { base: 0.06, amp: 0.08, freq: g.bands * 0.5 };
}

function mixOf(world) {
  const { mat, mat2, blend, dom } = world, acc = {};
  const add = (m, w) => { const k = MIX_OF[MATERIALS[m]]; acc[k] = (acc[k] ?? 0) + w; };
  for (let i = 0; i < dom.size; i++) {
    const f = blend[i];
    add(mat[i], dom.area[i] * (1 - f));
    if (f > 0) add(mat2[i], dom.area[i] * f);
  }
  return Object.entries(acc).map(([label, frac]) => ({ label, pct: frac * 100 })).sort((a, b) => b.pct - a.pct);
}
