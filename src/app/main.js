// playplanetone: rolls and builds worlds (src/gen/planet.js) and draws them
// (view.js). All rules live in planet.js; this file only draws and wires buttons.

import { rollSpec, moonOf, buildWorld, label, SUBTYPES, MOON_SUBTYPES, MATERIALS, typeWeights, newSeed } from '../gen/planet.js';
import { icosphere, getCube, getGeo, geoLevel } from '../gen/sphere.js';
import { drawWorld } from './view.js';

const $ = id => document.getElementById(id);
const TEXELS = [32, 48, 64, 96, 128];
const SLIDERS = [
  { id: 'sub', label: 'Polygons', min: 1, max: 5, step: 1, def: 3, show: v => `${icosphere(v).count} tris`, title: 'Icosphere subdivision: the globe silhouette and facets.' },
  { id: 'texels', label: 'Detail', min: 0, max: TEXELS.length - 1, step: 1, def: 2, show: v => `${TEXELS[v]}² / L${geoLevel(TEXELS[v])}`, title: 'Surface detail, independent of polygons: cube-map texels per face edge, or the geodesic level with about as many cells.', rebuild: true },
  { id: 'relief', label: 'Relief', min: 0, max: 3, step: 0.1, def: 1, title: 'Height displacement of the mesh.' },
  { id: 'bump', label: 'Texel shading', min: 0, max: 3, step: 0.1, def: 1, title: 'Light the slope stored per texel, finer than the mesh.' },
  { id: 'speed', label: 'Spin speed', min: 0.1, max: 0.9, step: 0.05, def: 0.1, title: 'Planet spin. In the game this will mostly come from how close the planet is to its sun.' },
];
const opt = Object.fromEntries(SLIDERS.map(s => [s.id, s.def]));

let spec, world, world2 = null, run = [], cur = -1, time = 0, spin = 0;
const proj = () => $('proj').value;
const thumbProj = () => (proj() === 'geo' ? 'geo' : 'cube');

// ---------------------------------------------------------------- sliders

function buildSliders() {
  for (const d of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'sl';
    row.title = d.title ?? '';
    row.innerHTML = `<label>${d.label}</label><input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${opt[d.id]}"><output></output>`;
    const input = row.querySelector('input'), out = row.querySelector('output');
    const show = () => { out.textContent = d.show ? d.show(opt[d.id]) : opt[d.id]; };
    show();
    input.oninput = () => { opt[d.id] = +input.value; show(); if (d.rebuild) rebuild(); draw(); };
    $('sliders').append(row);
  }
}

// ---------------------------------------------------------------- worlds

function timedBuild(p, cap) {
  const N = TEXELS[opt.texels], dom = p === 'geo' ? getGeo(geoLevel(N)) : getCube(N); // warm the domain cache outside the timing
  const t = performance.now(), w = buildWorld(spec, N, p);
  $(cap).textContent = `${p === 'geo' ? 'geodesic' : 'cube map'} · ${dom.label} · built in ${Math.round(performance.now() - t)} ms`;
  return w;
}

function rebuild() {
  const p = proj();
  world = timedBuild(p === 'both' ? 'cube' : p, 'cap1');
  world2 = p === 'both' ? timedBuild('geo', 'cap2') : null;
  document.querySelector('.view').classList.toggle('both', p === 'both');
  showInfo();
}

function show(s, { push = false } = {}) {
  spec = s;
  rebuild();
  if (push) { run.push({ spec: s }); cur = run.length - 1; }
  $('seed').value = s.seed;
  try { location.replace('#' + hashOf(s)); } catch {} // hosts that block hash state still work, just without the link
  drawStrip();
  draw();
}

const planetHistory = () => run.filter(r => r.spec.kind === 'planet').map(r => r.spec.type);

function nextWorld() {
  const s = rollSpec({ history: planetHistory() });
  const no = run.filter(r => r.spec.kind === 'planet').length + 1;
  show(s, { push: true });
  // Every 3rd world rolls 50/50 for a moon, built from the planet's data, muted.
  if (no % 3 === 0 && Math.random() < 0.5) { run.push({ spec: moonOf(s), moon: true }); drawStrip(); }
}

function fromControls(kind) {
  const type = $('type').value || undefined, sub = $('subtype').value || undefined;
  return kind === 'moon' ? rollSpec({ kind: 'moon', subtype: sub && MOON_SUBTYPES[sub] ? sub : undefined }) : rollSpec({ type, subtype: type ? sub : undefined, history: planetHistory() });
}

function fillSubtypes() {
  const t = $('type').value, sel = $('subtype'), keep = sel.value;
  sel.textContent = '';
  const add = (v, txt) => { const o = document.createElement('option'); o.value = v; o.textContent = txt; sel.append(o); };
  add('', 'Any subtype');
  if (t) for (const k of Object.keys(SUBTYPES[t])) add(k, k);
  const g = document.createElement('optgroup'); g.label = 'Moons';
  for (const k of Object.keys(MOON_SUBTYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = `${k} moon`; g.append(o); }
  sel.append(g);
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

// ---------------------------------------------------------------- hash

function hashOf(s) {
  const p = new URLSearchParams({ k: s.kind, t: s.type, s: s.subtype, seed: s.seed });
  if (s.muted || s.parent) { p.set('pt', s.parent.type); p.set('ps', s.parent.subtype); p.set('pseed', s.parent.seed); p.set('mut', s.muted ? 1 : 0); }
  return p.toString();
}

function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('seed')) return null;
  const seed = +p.get('seed') >>> 0;
  if (p.get('pseed')) {
    const parent = rollSpec({ type: p.get('pt'), subtype: p.get('ps'), seed: +p.get('pseed') >>> 0 });
    return moonOf(parent, seed);
  }
  return p.get('k') === 'moon' ? rollSpec({ kind: 'moon', subtype: p.get('s'), seed }) : rollSpec({ type: p.get('t'), subtype: p.get('s'), seed });
}

// ---------------------------------------------------------------- info

const meter = (name, v, txt = v.toFixed(2)) => `<div class="meter"><span>${name}</span><div class="track"><div class="fill" style="width:${Math.round(Math.min(1, v) * 100)}%"></div></div><span>${txt}</span></div>`;
const SIZE = ['small', 'medium', 'large'];

function showInfo() {
  const s = spec;
  $('name').textContent = label(s);
  $('meta').textContent = `${s.kind === 'moon' ? 'moon' : SIZE[s.size]} · seed ${s.seed} · tilt ${Math.round(s.tilt * 57.3)}°${s.parent ? ` · parent: ${s.parent.subtype} ${s.parent.type}` : ''}`;
  if (s.type === 'gas') {
    $('ctor').innerHTML = meter('bands', s.g.bands / 12, s.g.bands) + meter('warp', s.g.warp / 0.3) + meter('storms', s.g.storms / 9, s.g.storms) + meter('twist', s.g.twist / 5);
  } else {
    const c = s.c;
    $('ctor').innerHTML = ['heat', 'activity', 'atmo', 'water', 'life'].map(k => meter(k === 'atmo' ? 'atmosphere' : k, c[k])).join('');
  }
  $('steps').innerHTML = world.steps.map(st => `<li><b>${st.id}</b>${st.note ? ` <span class="note">${st.note}</span>` : ''}</li>`).join('');
  $('dropped').textContent = world.dropped.length ? `Dropped for size: ${world.dropped.join(', ')}` : '';
  $('mix').innerHTML = world.mix.filter(m => m.pct >= 0.5).map(m => meter(m.label, m.pct / 100, `${Math.round(m.pct)}%`)).join('');
  const used = new Set(world.mat);
  world.blend.forEach((f, i) => { if (f > 0) used.add(world.mat2[i]); });
  $('palette').innerHTML = [...used].sort((a, b) => a - b).map(m => {
    const r = [...world.ramps[m]].map(c => `<i style="background:rgb(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255})"></i>`).join('');
    return `<div class="sw"><div class="ramp">${r}</div>${MATERIALS[m]}</div>`;
  }).join('');
}

// ---------------------------------------------------------------- run strip and gallery

function thumb(s, size, N = 32, sub = 3) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  drawWorld(cv, buildWorld(s, N, thumbProj()), { sub, spin: 0.6 });
  return cv;
}

function drawStrip() {
  const tw = typeWeights(planetHistory());
  const tot = Object.values(tw).reduce((a, b) => a + b, 0);
  $('weights').textContent = `Next type odds: ${Object.entries(tw).map(([k, v]) => `${k} ${Math.round(v / tot * 100)}%`).join(' · ')}  (last world ×0.3, the one before ×0.6)`;
  const strip = $('strip');
  strip.textContent = '';
  let no = 0;
  run.forEach((r, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (i === cur ? ' sel' : '');
    if (!r.cv) r.cv = thumb(r.spec, 48);
    if (r.spec.kind === 'planet') no++;
    chip.append(r.cv);
    const bar = document.createElement('div');
    bar.className = 't ' + (r.spec.kind === 'moon' ? 'moon' : r.spec.type);
    chip.append(bar);
    const txt = document.createElement('div');
    txt.textContent = r.moon ? `${no}: moon` : `${no}: ${r.spec.subtype}`;
    chip.append(txt);
    chip.title = label(r.spec);
    chip.onclick = () => { cur = i; show(r.spec); };
    strip.append(chip);
  });
  strip.scrollLeft = strip.scrollWidth;
}

function gallery(make) {
  const g = $('gallery');
  g.textContent = '';
  const specs = Array.from({ length: 12 }, make);
  let k = 0;
  const step = () => { // one per frame, so the page stays responsive
    if (k >= specs.length) return;
    const s = specs[k++], cell = document.createElement('div');
    cell.className = 'cell';
    cell.append(thumb(s, 120, 48, 3));
    const t = document.createElement('div'); t.textContent = label(s); cell.append(t);
    cell.onclick = () => { cur = -1; show(s); drawStrip(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    g.append(cell);
    requestAnimationFrame(step);
  };
  step();
}

// ---------------------------------------------------------------- draw loop

function draw() {
  if (!world) return;
  const o = {
    spin, time, sub: opt.sub, relief: opt.relief, bump: opt.bump,
    faceted: $('faceted').checked, clouds: $('clouds').checked, atmo: $('atmo').checked, wire: $('wire').checked,
  };
  drawWorld($('world'), world, o);
  if (world2) drawWorld($('world2'), world2, o);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if ($('rotate').checked && opt.speed > 0) { spin += dt * 0.25 * opt.speed; time += dt * 1.5 * opt.speed; draw(); }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- wiring

buildSliders();
fillSubtypes();
$('type').onchange = fillSubtypes;
$('next').onclick = nextWorld;
$('newPlanet').onclick = () => { cur = -1; show(fromControls('planet')); drawStrip(); };
$('newMoon').onclick = () => { cur = -1; show(fromControls('moon')); drawStrip(); };
$('moonOf').onclick = () => { const p = spec.kind === 'moon' && spec.parent ? rollSpec({ type: spec.parent.type, subtype: spec.parent.subtype, seed: spec.parent.seed }) : spec; if (p.kind === 'planet') { cur = -1; show(moonOf(p)); drawStrip(); } };
$('go').onclick = () => { const seed = +$('seed').value >>> 0; show(spec.kind === 'moon' && !spec.parent ? rollSpec({ kind: 'moon', subtype: spec.subtype, seed }) : spec.parent ? moonOf(rollSpec({ type: spec.parent.type, subtype: spec.parent.subtype, seed: spec.parent.seed }), seed) : rollSpec({ type: spec.type, subtype: spec.subtype, seed })); };
for (const id of ['clouds', 'atmo', 'faceted', 'wire']) $(id).onchange = draw;
$('proj').onchange = () => { rebuild(); draw(); for (const r of run) r.cv = null; drawStrip(); };
for (const b of document.querySelectorAll('[data-screen]')) b.onclick = () => {
  $('world').width = $('world').height = $('world2').width = $('world2').height = +b.dataset.screen;
  document.querySelectorAll('[data-screen]').forEach(x => x.classList.toggle('on', x === b));
  draw();
};
document.querySelector('[data-screen="240"]').classList.add('on');
$('roll12').onclick = () => gallery(() => rollSpec({ seed: newSeed() }));
$('roll12m').onclick = () => gallery(() => rollSpec({ kind: 'moon' }));
$('roll12s').onclick = () => {
  const t = $('type').value || undefined, sub = $('subtype').value || undefined;
  gallery(() => sub && MOON_SUBTYPES[sub] && !(t && SUBTYPES[t][sub]) ? rollSpec({ kind: 'moon', subtype: sub }) : rollSpec({ type: t, subtype: t ? sub : undefined }));
};

const start = fromHash();
if (start) show(start); else nextWorld();
requestAnimationFrame(frame);
