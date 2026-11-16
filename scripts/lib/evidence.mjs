// Shared evidence math for the demo pack builder and its rebuild verifier.
// Both scripts must derive reference samples through exactly the same code
// path, otherwise the pass/fail contract can drift between them.
import {
  resampleArea, rotate90, bleedTransparentRGB, extendEdges,
} from '../../src/core/rgba.mjs';
import { sampleTileAtLevel, sampleBilinearPage } from '../../src/core/atlas.mjs';

export const PROBE_POINTS = [
  ['center', 0.5, 0.5],
  ['border-tl', 0.12, 0.12],
  ['border-br', 0.88, 0.88],
];

// Rebuild a tile's L0 patch the same way atlas.buildMode does, starting from
// the original unrotated source: rotate for packing when required, dilate
// transparent RGB, then extend the edges by the level-0 padding.
export function tileOwnPatch(tile, placement, page, sourceImage) {
  let own = sourceImage;
  if (placement.rotated) own = rotate90(own);
  bleedTransparentRGB(own);
  return extendEdges(own, page.pad, page.pad, page.pad, page.pad);
}

// Evaluate one sampled-colour probe. Returns every number needed for the
// evidence record and for re-verification, including the ORIGINAL source uv
// that sampleTileAtLevel consumes and the rotated uv used on the own patch.
export function evaluateProbe(atlas, tile, placement, page, own, level, name, u0, v0) {
  const lv = tile.levels[level];
  const padL = Math.max(1, page.pad >> level);
  const ref = resampleArea(own, lv.w + padL * 2, lv.h + padL * 2);
  const [u, v] = placement.rotated ? [1 - v0, u0] : [u0, v0];
  const got = sampleTileAtLevel(atlas, tile.id, level, u0, v0);
  const refU = (padL + u * lv.w) / ref.width;
  const refV = (padL + v * lv.h) / ref.height;
  const refPx = sampleBilinearPage(ref, refU, refV);
  const rgbDelta = Math.max(
    Math.abs(got[0] - refPx[0]), Math.abs(got[1] - refPx[1]), Math.abs(got[2] - refPx[2]),
  );
  const alphaDelta = Math.abs(got[3] - refPx[3]);
  const interiorOpaque = name === 'center' && got[3] >= 250 && refPx[3] >= 250;
  return {
    name,
    level,
    uv: [u0, v0],
    rotatedUv: [u, v],
    sampled: got,
    ownPatchReference: refPx,
    rgbDelta,
    alphaDelta,
    interiorOpaque,
    pass: interiorOpaque ? rgbDelta <= 2 : rgbDelta <= 12 && alphaDelta <= 24,
  };
}

export function sampledColorEvidence(atlas, sourcesById) {
  const out = [];
  for (const tile of atlas.tiles) {
    const page = atlas.guarded.pages[tile.pageIndex];
    const placement = page.placements.find((p) => p.id === tile.id);
    const own = tileOwnPatch(tile, placement, page, sourcesById.get(tile.id));
    const probes = [];
    for (const level of [0, 1, 2]) {
      const lv = tile.levels[level];
      if (!lv || lv.x === null) continue;
      for (const [name, u, v] of PROBE_POINTS) {
        probes.push(evaluateProbe(atlas, tile, placement, page, own, level, name, u, v));
      }
    }
    out.push({ id: tile.id, probes });
  }
  return out;
}
