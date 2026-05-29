import * as THREE from "three";
import { SETTINGS } from "./config.js";
import { toonMat, addOutline } from "./toon.js";
import { hasTerrain, sampleTerrainHeight } from "./terrain.js";
import { hasAnim } from "./anim.js";

// Cartes chargées dynamiquement depuis public/data/maps/*.json (socle de l'éditeur).
// Schéma d'un fichier carte :
//   { id, name, size, floorColor, background, wallColor, coverColor, accentColor,
//     fog:{color,near,far},
//     lights:{ hemisphere:{sky,ground,intensity}, directional:{color,intensity,position,castShadow,shadowMapSize},
//              fill:{color,intensity,position}, ambient:{color,intensity} },
//     covers:[ {pos:[x,y,z], size:[w,h,d], accent?} ],
//     spawns:[ [x,y,z] ],
//     pickups:[ {id, type, pos:[x,y,z], healAmount} ] }
// Les couleurs sont des chaînes CSS "#rrggbb" (THREE.Color/les matériaux les acceptent).

const MAP_FILES = ["arena", "tours", "ascension", "nexus"];
const MAPS = {};

// Liste des cartes pour l'UI (remplie par loadMaps, référence stable).
export const MAP_LIST = [];

// Cartes intégrées au jeu (non supprimables par l'éditeur).
export const BUILTIN_MAP_IDS = new Set(MAP_FILES);

/** Charge tous les fichiers de cartes intégrées. À appeler une fois au boot. */
export async function loadMaps() {
  MAP_LIST.length = 0;
  for (const id of Object.keys(MAPS)) delete MAPS[id];
  for (const id of MAP_FILES) {
    try {
      const res = await fetch(`data/maps/${id}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = await res.json();
      const mapId = m.id || id;
      MAPS[mapId] = m;
      MAP_LIST.push({ id: mapId, name: m.name || mapId });
    } catch (e) {
      console.error(`[arena] chargement de la carte "${id}" impossible :`, e);
    }
  }
  return MAPS;
}

/**
 * Enregistre (ou remplace) une carte dans le moteur pour la rendre jouable et
 * sélectionnable. Utilisé par l'éditeur (cartes custom + prévisualisation « Tester »).
 * @param {object} map Carte au format public/data/maps/*.json (doit avoir un `id`).
 * @returns {string} l'id enregistré
 */
export function registerMap(map, opts = {}) {
  if (!map || typeof map !== "object" || !map.id) throw new Error("carte invalide (id manquant)");
  const id = String(map.id);
  MAPS[id] = map;
  if (opts.listed !== false) {
    const entry = MAP_LIST.find((e) => e.id === id);
    if (entry) entry.name = map.name || id;
    else MAP_LIST.push({ id, name: map.name || id });
  }
  return id;
}

/** Retire une carte enregistrée (sauf cartes intégrées). */
export function unregisterMap(id) {
  if (BUILTIN_MAP_IDS.has(id)) return;
  delete MAPS[id];
  const i = MAP_LIST.findIndex((e) => e.id === id);
  if (i >= 0) MAP_LIST.splice(i, 1);
}

/** Renvoie la donnée brute d'une carte chargée (ou null). */
export function getMap(id) { return MAPS[id] || null; }

/**
 * Garantit qu'une carte est chargée (la récupère depuis data/maps/<id>.json si absente).
 * Sert au mode EN LIGNE où le serveur peut imposer une carte aléatoire/publiée que le
 * client n'a pas encore en mémoire. Renvoie l'objet carte ou null.
 */
export async function ensureMap(id) {
  if (!id) return null;
  if (MAPS[id]) return MAPS[id];
  try {
    const res = await fetch(`data/maps/${id}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();
    m.id = m.id || id;
    registerMap(m, { listed: false });
    return m;
  } catch (e) {
    console.error(`[arena] carte "${id}" introuvable :`, e);
    return null;
  }
}

function getMapData(mapId) {
  return MAPS[mapId] || MAPS.arena || Object.values(MAPS)[0] || null;
}

/**
 * Construit la scène de jeu (lumières, sol, murs, couvertures) à partir des données carte.
 * @param {THREE.Scene} scene
 * @param {string} mapId
 * @param {{ shadows?: boolean, shadowMapSize?: number }} [opts] options de qualité
 */
export function buildArena(scene, mapId = "arena", opts = {}) {
  const map = getMapData(mapId);
  if (!map) throw new Error("Aucune carte chargée (loadMaps() a-t-il été appelé ?)");
  return buildArenaFromData(scene, map, opts);
}

/**
 * Variante prenant directement un objet carte (au lieu d'un id). Utilisée par
 * l'éditeur pour un rendu WYSIWYG d'une carte en cours d'édition.
 * @param {THREE.Scene} scene
 * @param {object} map donnée de carte
 * @param {{ shadows?: boolean, shadowMapSize?: number }} [opts]
 */
export function buildArenaFromData(scene, map, opts = {}) {
  if (!map) throw new Error("buildArenaFromData : carte nulle");

  const size = map.size || SETTINGS.arenaSize;
  const half = size / 2;
  const shadowsOn = opts.shadows !== false;
  const shadowMapSize = opts.shadowMapSize || map.lights?.directional?.shadowMapSize || 2048;

  const group = new THREE.Group();
  const colliders = [];
  const coverPoints = [];
  const animated = [];   // objets animés : { mesh, base:{pos:[3],rot:[3]}, anim }

  // --- Lumières ---
  const L = map.lights || {};
  if (L.hemisphere) {
    scene.add(new THREE.HemisphereLight(L.hemisphere.sky, L.hemisphere.ground, L.hemisphere.intensity ?? 1));
  }
  const dirCfg = L.directional || {};
  const dir = new THREE.DirectionalLight(dirCfg.color || 0xffffff, dirCfg.intensity ?? 1.9);
  const dp = dirCfg.position || [20, 40, 15];
  dir.position.set(dp[0], dp[1], dp[2]);
  dir.castShadow = shadowsOn && dirCfg.castShadow !== false;
  if (dir.castShadow) {
    dir.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    dir.shadow.camera.left = -half; dir.shadow.camera.right = half;
    dir.shadow.camera.top = half; dir.shadow.camera.bottom = -half;
  }
  scene.add(dir);
  if (L.fill) {
    const fill = new THREE.DirectionalLight(L.fill.color, L.fill.intensity ?? 0.5);
    const fp = L.fill.position || [-25, 20, -20];
    fill.position.set(fp[0], fp[1], fp[2]);
    scene.add(fill);
  }
  if (L.ambient) scene.add(new THREE.AmbientLight(L.ambient.color, L.ambient.intensity ?? 0.7));

  const fog = map.fog || {};
  scene.fog = new THREE.Fog(fog.color || 0x141b26, fog.near ?? 70, fog.far ?? 190);
  scene.background = new THREE.Color(map.background || 0x141b26);

  // --- Sol ---
  const floorMat = toonMat(map.floorColor || "#2b3850", { roughness: 1 });
  const terrain = hasTerrain(map.terrain) ? map.terrain : null;
  let floor;
  if (terrain) {
    // Sol relief : PlaneGeometry déformée par la heightmap (sampling partagé).
    const seg = terrain.seg;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    const n = seg + 1, half2 = size / 2, cell = size / seg;
    const pos = geo.attributes.position;
    // Ordre des sommets PlaneGeometry : iy de haut (+y local) en bas → world z croissant.
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = -half2 + ix * cell, wz = -half2 + iy * cell;
        pos.setZ(iy * n + ix, sampleTerrainHeight(terrain, wx, wz)); // local z → world y après rotation
      }
    }
    geo.computeVertexNormals();
    floor = new THREE.Mesh(geo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);
  } else {
    floor = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size), floorMat);
    floor.position.y = -0.5; floor.receiveShadow = true;
    group.add(floor);
  }

  const grid = new THREE.GridHelper(size, size / 2, 0xff9e2c, 0x2a2e36);
  grid.material.opacity = 0.16; grid.material.transparent = true;
  grid.position.y = 0.02;
  group.add(grid);

  // Cache de géométries : partage les BoxGeometry identiques (moins d'allocations GPU).
  const geoCache = new Map();
  const boxGeo = (w, h, d) => {
    const key = `${w}|${h}|${d}`;
    let g = geoCache.get(key);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(key, g); }
    return g;
  };

  // --- Murs de bordure : INVISIBLES, hauteur quasi infinie (anti-sortie d'arène) ---
  // Optionnels : map.borderWalls === false → arène totalement ouverte.
  // Aucun mesh rendu ; uniquement des colliders très hauts le long des 4 bords.
  if (map.borderWalls !== false) {
    const t = 1, WALL_TOP = 1000, WALL_BOT = -100; // hauteur "infinie"
    for (const [cx, cz, w, d] of [
      [0, -half, size, t],
      [0, half, size, t],
      [-half, 0, t, size],
      [half, 0, t, size],
    ]) {
      colliders.push(new THREE.Box3(
        new THREE.Vector3(cx - w / 2, WALL_BOT, cz - d / 2),
        new THREE.Vector3(cx + w / 2, WALL_TOP, cz + d / 2),
      ));
    }
  }

  // --- Couvertures (toon + contour) ---
  const coverMat = toonMat(map.coverColor || "#2b3a4f");
  const accentMat = toonMat(map.accentColor || "#ff9e2c", { emissive: 0x3a2408 });
  (map.covers || []).forEach((c) => {
    const [x, y, z] = c.pos;
    const [w, h, d] = c.size;
    const m = new THREE.Mesh(boxGeo(w, h, d), c.accent ? accentMat : coverMat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    // rotation : array [x,y,z] (radians) ou nombre (yaw seul, rétro-compat)
    const rr = Array.isArray(c.rot) ? c.rot : [0, c.rot || 0, 0];
    m.rotation.set(rr[0] || 0, rr[1] || 0, rr[2] || 0);
    group.add(m);
    m.updateMatrixWorld(true);
    colliders.push(new THREE.Box3().setFromObject(m));
    addOutline(m, 1.0 + 0.5 / Math.max(w, h, d)); // contour ~0.25u
    coverPoints.push(new THREE.Vector3(x, SETTINGS.playerHeight, z));
    if (hasAnim(c.anim)) {
      animated.push({ mesh: m, base: { pos: [x, y, z], rot: [rr[0] || 0, rr[1] || 0, rr[2] || 0] }, anim: c.anim });
    }
  });

  // --- Eau (optionnelle) ---
  // Schéma : map.water = { level: y, color: "#rrggbb", opacity: 0..1 }.
  // Plan translucide animé (ondulation légère), purement visuel — pas de collision.
  let water = null;
  if (map.water && typeof map.water.level === "number") {
    const wMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(map.water.color || "#2e6f8e"),
      transparent: true, opacity: map.water.opacity ?? 0.6,
      roughness: 0.2, metalness: 0.1,
    });
    water = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), wMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = map.water.level;
    water.receiveShadow = true;
    water.userData.baseY = map.water.level;
    group.add(water);
  }

  // --- Téléporteurs (optionnels) ---
  // Schéma : map.teleporters = [ { from:[x,y,z], to:[x,y,z], r? } ]. Entrer dans la
  // zone `from` téléporte le joueur en `to`. Marqueur visuel (anneau + colonne) aux 2 bouts.
  const teleporters = [];
  for (const tp of (Array.isArray(map.teleporters) ? map.teleporters : [])) {
    if (!Array.isArray(tp.from) || !Array.isArray(tp.to)) continue;
    const r = tp.r || 1.3;
    teleporters.push({ from: tp.from.slice(), to: tp.to.slice(), r });
    const mkMarker = (p, color) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.08, 8, 24), mat);
      ring.rotation.x = -Math.PI / 2; ring.position.set(p[0], p[1] - SETTINGS.playerHeight + 0.06, p[2]);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 5, 20, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      beam.position.set(p[0], p[1] - SETTINGS.playerHeight + 2.5, p[2]);
      g.add(ring, beam);
      group.add(g);
    };
    mkMarker(tp.from, 0x4fc3ff);  // entrée (bleu)
    mkMarker(tp.to, 0xff9e2c);    // sortie (ambre)
  }

  // --- Tyroliennes (optionnelles) ---
  // Schéma : map.ziplines = [ { a:[x,y,z], b:[x,y,z], speed? } ]. Câble + petites bornes.
  // S'accroche avec E près d'une extrémité ; on glisse jusqu'à l'autre bout.
  const ziplines = [];
  for (const zl of (Array.isArray(map.ziplines) ? map.ziplines : [])) {
    if (!Array.isArray(zl.a) || !Array.isArray(zl.b)) continue;
    const a = new THREE.Vector3(zl.a[0], zl.a[1] + 2.0, zl.a[2]);
    const b = new THREE.Vector3(zl.b[0], zl.b[1] + 2.0, zl.b[2]);
    ziplines.push({ a: zl.a.slice(), b: zl.b.slice(), top: [a.x, a.y, a.z], speed: zl.speed || 16, r: zl.r || 2.0 });
    const cableGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0xffd27a }));
    group.add(cable);
    for (const p of [a, b]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, p.y, 6),
        toonMat(map.coverColor || "#2b3a4f"));
      post.position.set(p.x, p.y / 2, p.z); post.castShadow = true;
      group.add(post);
    }
  }

  scene.add(group);

  // Spawns : depuis la carte, sinon 6 points calculés (coins + axes).
  let spawns;
  if (Array.isArray(map.spawns) && map.spawns.length) {
    spawns = map.spawns.map((s) => new THREE.Vector3(s[0], s[1], s[2]));
  } else {
    const s = half - 6;
    spawns = [
      new THREE.Vector3(-s, SETTINGS.playerHeight, -s),
      new THREE.Vector3(s, SETTINGS.playerHeight, s),
      new THREE.Vector3(s, SETTINGS.playerHeight, -s),
      new THREE.Vector3(-s, SETTINGS.playerHeight, s),
      new THREE.Vector3(0, SETTINGS.playerHeight, -s),
      new THREE.Vector3(0, SETTINGS.playerHeight, s),
    ];
  }

  const solids = [];
  group.traverse((o) => { if (o.isMesh && o.geometry.type === "BoxGeometry" && o.material.side !== THREE.BackSide) solids.push(o); });
  // occluders = ce qui BLOQUE les dégâts (blocs/cover). Le sol n'en fait PAS partie
  // (sinon une ondulation de terrain avale les tirs longue portée → sniper "ne hit pas").
  const occluders = solids.slice();
  // solids = ce qui arrête VISUELLEMENT les balles (tracer + impact) : on y ajoute le sol.
  if (floor && !solids.includes(floor)) solids.push(floor);

  return { group, colliders, spawns, solids, occluders, coverPoints, floor, floorMat, water, terrain, animated, teleporters, ziplines, map };
}
