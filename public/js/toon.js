import * as THREE from "three";

// Cel-shading façon Borderlands : matériaux toon (ombrage en paliers) + contours noirs.

// Rampe d'ombrage à paliers nets (4 niveaux).
function makeRamp() {
  const data = new Uint8Array([55, 120, 190, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const RAMP = makeRamp();

export function toonMat(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: RAMP, ...opts });
}

// Contour "coque inversée" : copie noire légèrement agrandie, faces arrière.
export function addOutline(mesh, scale = 1.05, color = 0x05070a) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color, side: THREE.BackSide })
  );
  outline.scale.setScalar(scale);
  mesh.add(outline);
  return outline;
}
