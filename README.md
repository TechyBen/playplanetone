# playplanetone

A toy procedural planet and moon generator with a PS1 look. Every world comes from a seed: rock, water and gas giant planets with many subtypes, plus moons. It's static files with no build, drawn by a small software rasteriser on a canvas.

It started as the planet generator for Eternal Plight, a wyvern shoot-'em-up whose levels begin in orbit above a planet and dive through its atmosphere. The seeded randomness is shared with [playtreeone](https://github.com/TechyBen/playtreeone).

## Run

```bash
python -m http.server 8191 --directory .
```

Then open http://localhost:8191/.

## How a world is made

1. **Roll a spec.** The type (rock, water or gas giant) is rolled with a bias against repeats: the last world's type is ×0.3 and the one before ×0.6. That makes runs varied without forbidding anything. The subtype is a plain roll. Size is small, medium or large.
2. **Constructor.** Each subtype gives ranges for heat, activity, atmosphere, water and life, and the spec rolls a value in each.
3. **Geological order.** The constructor picks which steps run, and in what order:
   - **Steps:** crust, plates, mountains, volcanism, craters, erosion, canyons, ice, seas, sediment and life.
   - **Order changes:** a hot start puts volcanism before plates, and a cold start puts ice before erosion, which carves glacial valleys. Craters can come before erosion (worn down) or after it (fresh).
   - **Size budget:** larger worlds get more steps (5, 7 or 9), and the lowest-priority steps drop first.
4. **Layers.** The steps work on layers sampled on the sphere: height, lava, ice, sand, desert, grass, forest, canyons, and plate boundaries.
   - **Plate boundaries:** straight about 10% of the time, otherwise a wave, a zigzag, or both, read from noise along each boundary so it never repeats. Plates meet in a slope, and about one pair in five keeps a cliff, faded along its length.
   - **Ice caps:** they have a fractal edge that breaks into tongues, bays and floes, and blends over a narrow band.
5. **Paint.** The layers become a material and tone per cell, coloured from pixel-art ramps (shadows slide cool, highlights warm).
6. **Level mix.** The share of the surface by area, such as plains, mountains or open sea. A game level built from the planet would take its layout weights from these.

Gas giants skip the layers. They use latitude bands, warped by noise and twisted by storms, and the bands drift at different speeds as the planet turns.

Moons roll from muted families: grey, clay, dust, ember, ice (with cracks along plate boundaries) and cold water. "Moon of this planet" instead takes a planet's data and mutes it: colder, calmer, thinner air, less water, no life, softer colours.

## Projections

Fields live on a domain: a set of cells, each with a direction, area, neighbours, and a lookup from direction to cell. There are two:

- **Geodesic cells** (the default): one cell per vertex of a subdivided icosphere, so hexagons plus twelve pentagons, with no face seams.
- **Cube map:** six square grids. It's kept for comparison, and **Side by side** shows both.

The two give almost the same worlds. Geodesic has slightly better fidelity and takes about 60% longer to generate: around 120 ms against 78 ms at the default detail.

## Controls

| Control | What it does |
|---|---|
| **Next world ▸** | Rolls a run of worlds. Every 3rd world rolls 50/50 for a moon |
| **New planet / New moon** | Rolls one, using the type and subtype menus if set |
| **Moon of this planet** | Builds a muted moon from the planet you're looking at |
| **Polygons** | The globe mesh, from 80 to 20,480 triangles (default 1,280) |
| **Detail** | Cells per surface, independent of polygons (default 64² / geodesic level 6) |
| **Relief, Texel shading** | Height on the mesh, and slope lighting finer than the mesh |
| **Spin speed** | 0.1–0.9 |
| **Screen** | Resolution of the low-res canvas |
| **Roll 12** | A gallery for judging variety |

The URL hash holds the current world, so a link reopens it.

## Layout

| Path | What |
|---|---|
| `index.html` | The toy page |
| `src/app/main.js` | Wires the controls, the run strip and the gallery |
| `src/app/view.js` | Software rasteriser: icosphere triangles, z-buffer, Bayer-dithered ramps, cloud shell, atmosphere rim |
| `src/gen/planet.js` | The generator. No DOM |
| `src/gen/sphere.js` | Domains (geodesic and cube map) and the icosphere mesh |
| `src/core/noise3.js` | 3D value, fBm and ridged noise |
| `src/core/colour.js` | HSL and the pixel-art ramp |
| `src/core/rng.js` | Seeded RNG, shared with playtreeone |
