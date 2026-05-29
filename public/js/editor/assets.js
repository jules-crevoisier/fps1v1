// Pipeline d'assets (offline) : chargement de modèles glTF/GLB et de textures.
//
// Conventions de dossiers (servis statiquement par Express depuis public/) :
//   - public/assets/models/   → modèles .glb / .gltf
//   - public/assets/textures/ → textures (jpg/png/webp)
// Dans les fichiers de carte JSON, les assets sont référencés par chemin RELATIF
// à public/, p.ex. "assets/models/crate.glb" ou "assets/textures/metal.jpg".
//
// GLTFLoader (addon Three.js) est vendu localement dans
// public/vendor/three/addons/ et importé dynamiquement : le bundle de jeu de base
// ne le charge que si une carte utilise réellement des modèles.

import * as THREE from "three";

let _gltfLoader = null;
let _texLoader = null;

/** Charge (paresseusement) une instance partagée de GLTFLoader. */
async function gltfLoader() {
  if (!_gltfLoader) {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    _gltfLoader = new GLTFLoader();
  }
  return _gltfLoader;
}

function texLoader() {
  if (!_texLoader) _texLoader = new THREE.TextureLoader();
  return _texLoader;
}

/**
 * Charge un modèle glTF/GLB et renvoie son groupe racine (Object3D).
 * @param {string} url chemin relatif (p.ex. "assets/models/crate.glb")
 * @returns {Promise<THREE.Object3D>}
 */
export async function loadModel(url) {
  const loader = await gltfLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) throw new Error("modèle glTF sans scène");
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return root;
}

/**
 * Charge un modèle depuis un objet File (import local dans l'éditeur, prévisualisation).
 * @param {File} file
 * @returns {Promise<THREE.Object3D>}
 */
export async function loadModelFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await loadModel(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Charge une texture en répétition et l'applique éventuellement à un matériau.
 * @param {string} url chemin relatif (p.ex. "assets/textures/metal.jpg")
 * @param {number} [repeat=1]
 * @returns {Promise<THREE.Texture>}
 */
export function loadTexture(url, repeat = 1) {
  return new Promise((resolve, reject) => {
    texLoader().load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

/**
 * Applique (de façon optionnelle et tolérante aux erreurs) la texture de sol et les
 * « props » glTF déclarés dans une carte, afin que le rendu en jeu corresponde à
 * l'éditeur (WYSIWYG). N'échoue jamais : une texture/un modèle manquant est ignoré.
 *
 * @param {THREE.Scene} scene
 * @param {object} map donnée de carte (peut contenir `floorTexture`, `props`)
 * @param {{ floor?: THREE.Mesh, floorMat?: THREE.Material, group?: THREE.Group }} env retour de buildArena
 * @returns {Promise<THREE.Object3D[]>} la liste des objets « props » ajoutés
 */
export async function decorateScene(scene, map, env) {
  const added = [];
  if (!map) return added;

  // Texture du sol (optionnelle).
  if (map.floorTexture && env?.floorMat) {
    try {
      const size = map.size || 60;
      env.floorMat.map = await loadTexture(map.floorTexture, Math.max(1, Math.round(size / 6)));
      env.floorMat.needsUpdate = true;
    } catch (e) {
      console.warn("[assets] texture de sol introuvable :", map.floorTexture, e?.message || e);
    }
  }

  // Props (modèles glTF placés dans la carte).
  for (const p of Array.isArray(map.props) ? map.props : []) {
    if (!p || !p.model) continue;
    try {
      const obj = await loadModel(p.model);
      const [x, y, z] = p.pos || [0, 0, 0];
      obj.position.set(x, y, z);
      if (typeof p.rot === "number") obj.rotation.y = p.rot;
      const s = p.scale ?? 1;
      obj.scale.setScalar(typeof s === "number" ? s : 1);
      obj.userData.prop = p;
      (env?.group || scene).add(obj);
      added.push(obj);
    } catch (e) {
      console.warn("[assets] modèle introuvable :", p.model, e?.message || e);
    }
  }
  return added;
}
