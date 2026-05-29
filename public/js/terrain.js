// Échantillonnage de terrain (heightmap) — SANS dépendance (THREE/Node).
// Partagé par le rendu client (arena.js), la physique (player.js) ET le serveur
// autoritaire (server.js) : une seule source de vérité pour la hauteur du sol.
//
// Format dans une carte :
//   map.terrain = { seg: N, size: S, heights: Float32-like length (N+1)*(N+1) }
//   - seg  : nombre de cellules par côté (vertices = seg+1 par côté)
//   - size : taille monde couverte (= map.size)
//   - heights[iy*(seg+1)+ix] : élévation Y du sommet (ix le long de X, iy le long de Z),
//     avec x = -size/2 + ix*cell et z = -size/2 + iy*cell, cell = size/seg.

/** Crée un terrain plat (toutes hauteurs à 0). */
export function makeTerrain(size, seg = 32) {
  const n = seg + 1;
  return { seg, size, heights: new Array(n * n).fill(0) };
}

/** Vrai si l'objet terrain est exploitable. */
export function hasTerrain(t) {
  return !!(t && t.seg > 0 && t.size > 0 && Array.isArray(t.heights) &&
    t.heights.length === (t.seg + 1) * (t.seg + 1));
}

/**
 * Hauteur Y du sol au point monde (x, z), par interpolation bilinéaire.
 * Renvoie 0 si le terrain est absent/invalide (sol plat compatible historique).
 */
export function sampleTerrainHeight(t, x, z) {
  if (!hasTerrain(t)) return 0;
  const { seg, size, heights } = t;
  const n = seg + 1, half = size / 2, cell = size / seg;
  let fx = (x + half) / cell, fz = (z + half) / cell;
  fx = Math.max(0, Math.min(seg, fx));
  fz = Math.max(0, Math.min(seg, fz));
  const ix = Math.floor(Math.min(seg - 1, fx)), iz = Math.floor(Math.min(seg - 1, fz));
  const tx = fx - ix, tz = fz - iz;
  const h00 = heights[iz * n + ix];
  const h10 = heights[iz * n + ix + 1];
  const h01 = heights[(iz + 1) * n + ix];
  const h11 = heights[(iz + 1) * n + ix + 1];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}
