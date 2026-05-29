import * as THREE from "three";
import { SETTINGS } from "./config.js";
import { toonMat, addOutline } from "./toon.js";

// Liste des cartes pour l'UI.
export const MAP_LIST = [
  { id: "arena", name: "Arène" },
  { id: "tours", name: "Tours" },
];

// Définition des cartes : couleur de sol + couvertures [x,y,z,w,h,d].
const MAPS = {
  arena: {
    floor: 0x2b3850,
    covers: [
      [0, 1.5, 0, 4, 3, 4],
      [-12, 1, -12, 5, 2, 5], [12, 1, 12, 5, 2, 5],
      [12, 1, -12, 5, 2, 5], [-12, 1, 12, 5, 2, 5],
      [0, 1, -18, 8, 2, 2], [0, 1, 18, 8, 2, 2],
      [-18, 1, 0, 2, 2, 8], [18, 1, 0, 2, 2, 8],
      [-7, 0.75, 4, 3, 1.5, 3], [7, 0.75, -4, 3, 1.5, 3],
    ],
  },
  tours: {
    floor: 0x382c47,
    covers: [
      // piliers hauts
      [-10, 2.5, -10, 3, 5, 3], [10, 2.5, 10, 3, 5, 3],
      [10, 2.5, -10, 3, 5, 3], [-10, 2.5, 10, 3, 5, 3],
      [0, 2.5, 0, 3, 5, 3],
      // murets bas
      [0, 0.75, -14, 10, 1.5, 1.5], [0, 0.75, 14, 10, 1.5, 1.5],
      [-14, 0.75, 0, 1.5, 1.5, 10], [14, 0.75, 0, 1.5, 1.5, 10],
      [-6, 0.75, 6, 2, 1.5, 2], [6, 0.75, -6, 2, 1.5, 2],
    ],
  },
};

export function buildArena(scene, mapId = "arena") {
  const map = MAPS[mapId] || MAPS.arena;
  const group = new THREE.Group();
  const colliders = [];
  const coverPoints = [];
  const half = SETTINGS.arenaSize / 2;

  // --- Lumières ---
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x40464f, 1.35);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.9);
  dir.position.set(20, 40, 15);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -half; dir.shadow.camera.right = half;
  dir.shadow.camera.top = half; dir.shadow.camera.bottom = -half;
  scene.add(dir);
  // second éclairage de remplissage opposé pour révéler les contours
  const fill = new THREE.DirectionalLight(0x8fb0ff, 0.5);
  fill.position.set(-25, 20, -20);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x55657a, 0.7));

  scene.fog = new THREE.Fog(0x141b26, 70, 190);
  scene.background = new THREE.Color(0x141b26);

  // --- Sol ---
  const floor = new THREE.Mesh(new THREE.BoxGeometry(SETTINGS.arenaSize, 1, SETTINGS.arenaSize), toonMat(map.floor, { roughness: 1 }));
  floor.position.y = -0.5; floor.receiveShadow = true;
  group.add(floor);

  const grid = new THREE.GridHelper(SETTINGS.arenaSize, SETTINGS.arenaSize / 2, 0xff9e2c, 0x2a2e36);
  grid.material.opacity = 0.16; grid.material.transparent = true;
  grid.position.y = 0.02;
  group.add(grid);

  // --- Murs ---
  const wallMat = toonMat(0x222d3d);
  const wallH = 6, t = 1;
  for (const [x, y, z, w, h, d] of [
    [0, wallH / 2, -half, SETTINGS.arenaSize, wallH, t],
    [0, wallH / 2, half, SETTINGS.arenaSize, wallH, t],
    [-half, wallH / 2, 0, t, wallH, SETTINGS.arenaSize],
    [half, wallH / 2, 0, t, wallH, SETTINGS.arenaSize],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    colliders.push(new THREE.Box3().setFromObject(m));
  }

  // --- Couvertures (toon + contour) ---
  const coverMat = toonMat(0x2b3a4f);
  const accentMat = toonMat(0xff9e2c, { emissive: 0x3a2408 });
  map.covers.forEach(([x, y, z, w, h, d], i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i === 0 ? accentMat : coverMat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    m.updateMatrixWorld(true);
    colliders.push(new THREE.Box3().setFromObject(m));
    addOutline(m, 1.0 + 0.5 / Math.max(w, h, d)); // contour ~0.25u
    coverPoints.push(new THREE.Vector3(x, SETTINGS.playerHeight, z));
  });

  scene.add(group);

  // Spawns : 6 points répartis (les 2 premiers = coins opposés pour le duel)
  const s = half - 6;
  const spawns = [
    new THREE.Vector3(-s, SETTINGS.playerHeight, -s),
    new THREE.Vector3(s, SETTINGS.playerHeight, s),
    new THREE.Vector3(s, SETTINGS.playerHeight, -s),
    new THREE.Vector3(-s, SETTINGS.playerHeight, s),
    new THREE.Vector3(0, SETTINGS.playerHeight, -s),
    new THREE.Vector3(0, SETTINGS.playerHeight, s),
  ];

  const solids = [];
  group.traverse((o) => { if (o.isMesh && o.geometry.type === "BoxGeometry" && o.material.side !== THREE.BackSide) solids.push(o); });

  return { group, colliders, spawns, solids, coverPoints };
}
