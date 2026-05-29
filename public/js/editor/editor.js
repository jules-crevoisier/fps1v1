// Éditeur de cartes intégré (mode « ÉDITEUR » du menu principal).
//
// Vue 3D à caméra orbitale (OrbitControls). On édite une carte au MÊME format que
// public/data/maps/*.json : le rendu réutilise la logique de buildArena (sol, murs,
// lumières, fog) pour rester WYSIWYG, et l'éditeur gère par-dessus des objets
// manipulables (covers, spawns, pickups) via gizmos (TransformControls) et un panneau.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { buildArenaFromData } from "../arena.js";
import { toonMat, addOutline } from "../toon.js";
import { decorateScene, loadModelFromFile } from "./assets.js";
import { EditorUI } from "./editorUI.js";
import { makeTerrain, hasTerrain, sampleTerrainHeight } from "../terrain.js";
import { hasAnim, sampleAnim, migrateToClip } from "../anim.js";
import { Animator } from "./animator.js";

const PLAYER_H = 1.7;

/** Carte vierge par défaut (format public/data/maps/*.json). */
export function blankMap(name = "Nouvelle carte") {
  return {
    version: 1, id: "", name, size: 60,
    floorColor: "#2b3850", background: "#141b26", wallColor: "#222d3d",
    coverColor: "#2b3a4f", accentColor: "#ff9e2c",
    fog: { color: "#141b26", near: 70, far: 190 },
    lights: {
      hemisphere: { sky: "#bfd8ff", ground: "#40464f", intensity: 1.35 },
      directional: { color: "#ffffff", intensity: 1.9, position: [20, 40, 15], castShadow: true, shadowMapSize: 2048 },
      fill: { color: "#8fb0ff", intensity: 0.5, position: [-25, 20, -20] },
      ambient: { color: "#55657a", intensity: 0.7 },
    },
    covers: [], spawns: [[-24, PLAYER_H, -24], [24, PLAYER_H, 24]], pickups: [], props: [],
  };
}

const deepClone = (o) => JSON.parse(JSON.stringify(o));

// Rotation d'un cover : tolère un nombre (yaw seul, rétro-compat) ou un array [x,y,z].
const rotArr = (r) => Array.isArray(r) ? [r[0] || 0, r[1] || 0, r[2] || 0] : [0, r || 0, 0];

export class Editor {
  /**
   * @param {THREE.WebGLRenderer} renderer renderer partagé du jeu
   * @param {HTMLCanvasElement} canvas
   * @param {{ onExit: () => void, onTest: (map: object) => void }} hooks
   */
  constructor(renderer, canvas, hooks) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.hooks = hooks;
    this.scene = null;
    this.camera = null;
    this.orbit = null;
    this.gizmo = null;
    this.baseEnv = null;
    this.map = blankMap();
    this.objects = [];          // [{ kind, mesh, data?, index? }]
    this.pickMeshes = [];       // meshes sélectionnables (raycast)
    this.selected = null;
    this.boxHelper = null;
    this.snap = true;
    this.gridStep = 1;
    this._running = false;
    this._raf = 0;
    this._ray = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._down = null;
    this._props = [];
    this.ui = new EditorUI(this);
    this.animator = new Animator();
    this._animObj = null;   // objet en cours d'édition dans l'animateur
    this._clock = new THREE.Clock();

    this.tool = "select";       // "select" | "sculpt"
    this.sculpting = false;      // bouton gauche maintenu pendant le sculpt
    this.brushMode = "raise";    // "raise" | "flatten" | "smooth"
    this.brushRadius = 6;
    this.brushStrength = 0.5;
    this.undoStack = [];
    this.redoStack = [];
    this.brushRing = null;       // anneau d'aperçu du pinceau

    this._onResize = () => this._resize();
    this._onPointerDown = (e) => {
      if (e.button === 0 && this.tool === "sculpt") {
        this.pushHistory();   // un coup de pinceau (down→up) = une entrée d'historique
        this.sculpting = true; this._sculptAt(e, e.altKey || e.shiftKey ? -1 : 1); e.preventDefault(); return;
      }
      this._down = { x: e.clientX, y: e.clientY };
    };
    this._onPointerMove = (e) => {
      if (this.sculpting) this._sculptAt(e, e.altKey || e.shiftKey ? -1 : 1);
      if (this.tool === "sculpt") this._updateBrushRing(e);
    };
    this._onPointerUp = (e) => {
      if (this.sculpting) { this.sculpting = false; return; }
      if (this.tool !== "select") return;
      this._handleClick(e);
    };
    this._onKey = (e) => this._handleKey(e);
  }

  _handleKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !e.shiftKey) { this.undo(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) { this.redo(); e.preventDefault(); return; }
    if (e.code === "Delete" || e.code === "Backspace") { this.deleteSelected(); e.preventDefault(); }
    else if (e.code === "KeyG") this.setMode("translate");
    else if (e.code === "KeyR") this.setMode("rotate");
    else if (e.code === "KeyT") this.setMode("scale");
    else if (e.code === "KeyD" && (e.ctrlKey || e.metaKey)) { this.duplicateSelected(); e.preventDefault(); }
    else if (e.code === "Escape") {
      if (this.tool === "sculpt") this.setTool("select");
      else this.select(null);
    }
  }

  // ---------------------------------------------------------------- cycle de vie
  open() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
    this.camera.position.set(40, 42, 40);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.495;   // ne pas passer sous le sol
    this.orbit.target.set(0, 1, 0);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setTranslationSnap(this.snap ? this.gridStep : null);
    this.gizmo.setRotationSnap(this.snap ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this.pushHistory(); // snapshot au début d'un déplacement/rotation/échelle
    });
    this.gizmo.addEventListener("objectChange", () => this._commitSelected());
    this.gizmo.addEventListener("mouseUp", () => this._bakeScale());
    this.scene.add(this.gizmo);

    this.boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xffd24a);
    this.boxHelper.visible = false;
    this.scene.add(this.boxHelper);

    // Anneau d'aperçu du pinceau (rayon = brushRadius), posé à plat sur le terrain.
    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.97, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.brushRing.rotation.x = -Math.PI / 2;
    this.brushRing.renderOrder = 998;
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);

    this.rebuildAll();

    addEventListener("resize", this._onResize);
    addEventListener("keydown", this._onKey);
    this.renderer.domElement.addEventListener("pointerdown", this._onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this._onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this._onPointerUp);

    this.ui.show();
    this._resize();
    this._running = true;
    this._clock.getDelta();
    this._loop();
  }

  close() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    removeEventListener("resize", this._onResize);
    removeEventListener("keydown", this._onKey);
    this.renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this._onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this._onPointerUp);
    this.ui.hide();
    this.animator.close(); this._animObj = null;
    if (this.gizmo) { this.gizmo.detach(); this.gizmo.dispose(); }
    if (this.orbit) this.orbit.dispose();
    this._disposeScene();
    this.scene = null;
  }

  _resize() {
    if (!this.camera) return;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const dt = Math.min(this._clock.getDelta(), 0.05);
    this.orbit.update();
    if (this.boxHelper.visible && this.selected) this.boxHelper.update();
    // léger flottement des pickups (cohérent avec le jeu)
    for (const o of this.objects) {
      if (o.kind === "pickup") o.mesh.rotation.y += dt * 0.9;
    }
    // Aperçu des covers animés.
    this._animTime = (this._animTime || 0) + dt;
    const animPlay = this.animator.isOpen ? this.animator.tick(dt) : 0;
    for (const o of this.objects) {
      if (o.kind !== "cover" || !hasAnim(o.data.anim)) continue;
      const base = o.data.pos, br = rotArr(o.data.rot);
      // objet en cours d'édition dans l'animateur : prévisualisé à la tête de lecture.
      if (o === this._animObj) {
        const off = sampleAnim(o.data.anim, animPlay);
        o.mesh.position.set(base[0] + off.p[0], base[1] + off.p[1], base[2] + off.p[2]);
        o.mesh.rotation.set(br[0] + off.r[0], br[1] + off.r[1], br[2] + off.r[2]);
        o.mesh.scale.setScalar(off.s ?? 1);
        continue;
      }
      // sélectionné (hors animateur) : figé à la pose de repos pour l'édition.
      if (o === this.selected) { o.mesh.position.set(base[0], base[1], base[2]); o.mesh.rotation.set(br[0], br[1], br[2]); o.mesh.scale.setScalar(1); continue; }
      const off = sampleAnim(o.data.anim, this._animTime);
      o.mesh.position.set(base[0] + off.p[0], base[1] + off.p[1], base[2] + off.p[2]);
      o.mesh.rotation.set(br[0] + off.r[0], br[1] + off.r[1], br[2] + off.r[2]);
      o.mesh.scale.setScalar(off.s ?? 1);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- historique (undo/redo)
  /** Empile l'état courant AVANT une modification (à appeler en début d'opération). */
  pushHistory() {
    (this.undoStack ||= []).push(JSON.stringify(this.map));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.ui?.refresh?.();
  }

  _applyState(json) {
    this.map = JSON.parse(json);
    this.map.covers ||= []; this.map.pickups ||= []; this.map.spawns ||= [];
    this.rebuildAll();
    this.select(null);
    this.ui.refresh();
  }

  undo() {
    if (!this.undoStack?.length) return;
    (this.redoStack ||= []).push(JSON.stringify(this.map));
    this._applyState(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack?.length) return;
    this.undoStack.push(JSON.stringify(this.map));
    this._applyState(this.redoStack.pop());
  }

  canUndo() { return !!this.undoStack?.length; }
  canRedo() { return !!this.redoStack?.length; }

  // ---------------------------------------------------------------- (re)construction
  /** Charge une carte (deep clone) puis reconstruit toute la scène. */
  loadMap(map) {
    this.map = deepClone(map);
    if (!Array.isArray(this.map.spawns) || this.map.spawns.length < 2) {
      this.map.spawns = [[-24, PLAYER_H, -24], [24, PLAYER_H, 24]];
    }
    this.map.covers ||= [];
    this.map.pickups ||= [];
    this.undoStack = []; this.redoStack = []; // nouvelle carte → historique vierge
    this.rebuildAll();
    this.select(null);
    this.ui.refresh();
  }

  /** Reconstruit l'environnement de base + les matériaux + les objets éditables. */
  rebuildAll() {
    this._rebuildBase();
    this._rebuildMaterials();
    this._rebuildObjects();
    decorateScene(this.scene, this.map, this.baseEnv).then((props) => {
      this._props = props || [];
    }).catch(() => {});
  }

  _disposeScene() {
    if (this.baseEnv?.group) this.scene?.remove(this.baseEnv.group);
  }

  _rebuildBase() {
    if (this.baseEnv?.group) this.scene.remove(this.baseEnv.group);
    // on retire lumières/fog précédents
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const c = this.scene.children[i];
      if (c.isLight) this.scene.remove(c);
    }
    // base SANS covers (gérés par l'éditeur) : on clone et on vide covers.
    const baseMap = { ...this.map, covers: [], props: [], teleporters: [], ziplines: [] };
    this.baseEnv = buildArenaFromData(this.scene, baseMap, { shadows: true, shadowMapSize: 1024, editor: true });
  }

  _rebuildMaterials() {
    this.coverMat = toonMat(this.map.coverColor || "#2b3a4f");
    this.accentMat = toonMat(this.map.accentColor || "#ff9e2c", { emissive: 0x3a2408 });
  }

  _clearObjects() {
    for (const o of this.objects) {
      o.mesh.parent?.remove(o.mesh);
      o.mesh.traverse?.((m) => { if (m.isMesh && m.geometry) m.geometry.dispose?.(); });
    }
    this.objects = [];
    this.pickMeshes = [];
  }

  _rebuildObjects() {
    this._clearObjects();
    (this.map.covers || []).forEach((c) => this._addCoverMesh(c));
    (this.map.spawns || []).forEach((s, i) => this._addSpawnMesh(i));
    (this.map.pickups || []).forEach((p) => this._addPickupMesh(p));
    (this.map.teleporters || []).forEach((tp, i) => this._addPairMeshes("tp", i, ["from", "to"], [0x4fc3ff, 0xff9e2c]));
    (this.map.ziplines || []).forEach((zl, i) => this._addPairMeshes("zip", i, ["a", "b"], [0xffd27a, 0xffd27a]));
  }

  _pairArr(type) { return type === "tp" ? (this.map.teleporters ||= []) : (this.map.ziplines ||= []); }

  // Poignées d'extrémités (déplaçables) + ligne de liaison pour un téléporteur/tyrolienne.
  _addPairMeshes(type, index, keys, colors) {
    const entry = this._pairArr(type)[index];
    if (!entry) return;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(keys.map((k) => new THREE.Vector3(...entry[k]))),
      new THREE.LineBasicMaterial({ color: colors[0], depthTest: false }));
    line.renderOrder = 990;
    this.baseEnv.group.add(line);
    keys.forEach((key, j) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), new THREE.MeshBasicMaterial({ color: colors[j] }));
      mesh.position.set(entry[key][0], entry[key][1], entry[key][2]);
      const obj = { kind: "endpoint", mesh, data: {}, ref: { type, index, key, keys, line } };
      mesh.userData.editObj = obj;
      this.baseEnv.group.add(mesh);
      this.objects.push(obj);
      this.pickMeshes.push(mesh);
    });
  }

  // ---------------------------------------------------------------- création de meshes
  _coverGeo(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

  _addCoverMesh(data) {
    const [w, h, d] = data.size;
    const mesh = new THREE.Mesh(this._coverGeo(w, h, d), data.accent ? this.accentMat : this.coverMat);
    mesh.position.set(data.pos[0], data.pos[1], data.pos[2]);
    { const rr = rotArr(data.rot); mesh.rotation.set(rr[0], rr[1], rr[2]); }
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.outline = addOutline(mesh, 1.0 + 0.5 / Math.max(w, h, d));
    const obj = { kind: "cover", mesh, data };
    mesh.userData.editObj = obj;
    this.baseEnv.group.add(mesh);
    this.objects.push(obj);
    this.pickMeshes.push(mesh);
    return obj;
  }

  _addSpawnMesh(index) {
    const s = this.map.spawns[index];
    const g = new THREE.Group();
    const col = index < 2 ? 0xff9e2c : 0x4fc3ff;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, PLAYER_H, 12),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 })
    );
    pole.position.y = 0;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.7, 12),
      new THREE.MeshBasicMaterial({ color: col })
    );
    cone.position.y = PLAYER_H / 2 + 0.45;
    g.add(pole, cone);
    g.position.set(s[0], s[1], s[2]);
    const obj = { kind: "spawn", mesh: g, index };
    g.userData.editObj = obj;
    this.baseEnv.group.add(g);
    this.objects.push(obj);
    this.pickMeshes.push(pole, cone);
    return obj;
  }

  _addPickupMesh(data) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45, 0),
      new THREE.MeshBasicMaterial({ color: 0x4cc46a })
    );
    mesh.position.set(data.pos[0], data.pos[1], data.pos[2]);
    const obj = { kind: "pickup", mesh, data };
    mesh.userData.editObj = obj;
    this.baseEnv.group.add(mesh);
    this.objects.push(obj);
    this.pickMeshes.push(mesh);
    return obj;
  }

  // ---------------------------------------------------------------- sélection
  _handleClick(e) {
    if (this.gizmo.dragging) return;
    if (!this._down) return;
    const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
    this._down = null;
    if (moved > 5) return;                 // c'était un drag (orbit), pas un clic
    this._pointer.x = (e.clientX / innerWidth) * 2 - 1;
    this._pointer.y = -(e.clientY / innerHeight) * 2 + 1;
    this._ray.setFromCamera(this._pointer, this.camera);
    const hits = this._ray.intersectObjects(this.pickMeshes, false);
    if (!hits.length) { this.select(null); return; }
    let o = hits[0].object;
    while (o && !o.userData.editObj) o = o.parent;
    this.select(o?.userData.editObj || null);
  }

  select(obj) {
    this.selected = obj;
    if (!obj) {
      this.gizmo.detach();
      this.boxHelper.visible = false;
      this.ui.showProperties(null);
      this.ui.highlightList(null);
      return;
    }
    this.gizmo.attach(obj.mesh);
    this._applyGizmoModeConstraints();
    this.boxHelper.setFromObject(obj.mesh);
    this.boxHelper.visible = true;
    this.ui.showProperties(obj);
    this.ui.highlightList(obj);
  }

  selectByListIndex(i) { this.select(this.objects[i] || null); }

  _applyGizmoModeConstraints() {
    // spawns/pickups : translation uniquement.
    if (this.selected && this.selected.kind !== "cover" && this.gizmo.mode !== "translate") {
      this.gizmo.setMode("translate");
      this.ui.setModeButton("translate");
    }
  }

  setMode(mode) {
    if (this.selected && this.selected.kind !== "cover" && mode !== "translate") return;
    this.gizmo.setMode(mode);
    this.ui.setModeButton(mode);
  }

  setSnap(on) {
    this.snap = on;
    this.gizmo.setTranslationSnap(on ? this.gridStep : null);
    this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
  }

  setGridStep(step) {
    this.gridStep = Math.max(0.25, step || 1);
    if (this.snap) this.gizmo.setTranslationSnap(this.gridStep);
  }

  // ---------------------------------------------------------------- édition / commit
  _commitSelected() {
    const o = this.selected;
    if (!o) return;
    const m = o.mesh;
    if (o.kind === "cover") {
      o.data.pos = [r(m.position.x), r(m.position.y), r(m.position.z)];
      o.data.rot = [+m.rotation.x.toFixed(4), +m.rotation.y.toFixed(4), +m.rotation.z.toFixed(4)];
    } else if (o.kind === "spawn") {
      this.map.spawns[o.index] = [r(m.position.x), r(m.position.y), r(m.position.z)];
    } else if (o.kind === "pickup") {
      o.data.pos = [r(m.position.x), r(m.position.y), r(m.position.z)];
    } else if (o.kind === "endpoint") {
      const { type, index, key, keys, line } = o.ref;
      const entry = this._pairArr(type)[index];
      if (entry) {
        entry[key] = [r(m.position.x), r(m.position.y), r(m.position.z)];
        line.geometry.setFromPoints(keys.map((k) => new THREE.Vector3(...entry[k])));
      }
    }
    this.ui.showProperties(o);
  }

  // À la fin d'un redimensionnement au gizmo : on « cuit » l'échelle dans la géométrie.
  _bakeScale() {
    const o = this.selected;
    if (!o || o.kind !== "cover" || this.gizmo.mode !== "scale") return;
    const m = o.mesh;
    const w = Math.max(0.2, o.data.size[0] * m.scale.x);
    const h = Math.max(0.2, o.data.size[1] * m.scale.y);
    const d = Math.max(0.2, o.data.size[2] * m.scale.z);
    o.data.size = [r(w), r(h), r(d)];
    m.scale.set(1, 1, 1);
    this._rebuildCoverGeometry(o);
    this.boxHelper.setFromObject(m);
    this.ui.showProperties(o);
  }

  _rebuildCoverGeometry(o) {
    const [w, h, d] = o.data.size;
    o.mesh.geometry.dispose();
    o.mesh.geometry = this._coverGeo(w, h, d);
    const oldOutline = o.mesh.userData.outline;
    if (oldOutline) { o.mesh.remove(oldOutline); oldOutline.material.dispose(); }
    o.mesh.userData.outline = addOutline(o.mesh, 1.0 + 0.5 / Math.max(w, h, d));
  }

  /** Mise à jour d'une propriété depuis le panneau (champ numérique / couleur). */
  // Réglages purement éditeur (n'altèrent pas la carte → pas d'historique).
  static EDITOR_ONLY_FIELDS = new Set(["brushRadius", "brushStrength", "brushMode"]);

  updateProp(field, value) {
    if (!Editor.EDITOR_ONLY_FIELDS.has(field)) this.pushHistory();
    const o = this.selected;
    if (o) this._updateObjectProp(o, field, value);
    else this._updateMapProp(field, value);
  }

  _updateObjectProp(o, field, value) {
    const m = o.mesh;
    if (field === "px") { m.position.x = value; this._commitSelected(); }
    else if (field === "py") { m.position.y = value; this._commitSelected(); }
    else if (field === "pz") { m.position.z = value; this._commitSelected(); }
    else if (field === "rotX") { m.rotation.x = THREE.MathUtils.degToRad(value); this._commitSelected(); }
    else if (field === "rotY") { m.rotation.y = THREE.MathUtils.degToRad(value); this._commitSelected(); }
    else if (field === "rotZ") { m.rotation.z = THREE.MathUtils.degToRad(value); this._commitSelected(); }
    else if (o.kind === "cover" && (field === "w" || field === "h" || field === "d")) {
      const idx = { w: 0, h: 1, d: 2 }[field];
      o.data.size[idx] = Math.max(0.2, value);
      this._rebuildCoverGeometry(o);
    } else if (o.kind === "cover" && field === "accent") {
      o.data.accent = !!value;
      o.mesh.material = value ? this.accentMat : this.coverMat;
    } else if (o.kind === "pickup" && field === "healAmount") {
      o.data.healAmount = Math.max(1, Math.round(value));
    }
    this.boxHelper.setFromObject(m);
  }

  _updateMapProp(field, value) {
    if (field === "name") { this.map.name = value; this.ui.refresh(); return; }
    if (field === "size") {
      this.map.size = Math.max(20, Math.min(160, Math.round(value)));
      if (this.map.terrain) this.map.terrain.size = this.map.size; // le relief s'étire
      this.rebuildAll();
      return;
    }
    if (field === "terrainOn") {
      if (value) this.map.terrain = makeTerrain(this.map.size, 48);
      else { delete this.map.terrain; if (this.tool === "sculpt") this.setTool("select"); }
      this.rebuildAll();
      this.ui.refresh();
      return;
    }
    if (field === "brushRadius") { this.brushRadius = Math.max(1, value); return; }
    if (field === "brushStrength") { this.brushStrength = Math.max(0.05, value); return; }
    if (["floorColor", "background", "wallColor", "coverColor", "accentColor"].includes(field)) {
      this.map[field] = value;
      this.rebuildAll();
      return;
    }
    if (field === "waterOn") {
      if (value) this.map.water ||= { level: 0.5, color: "#2e6f8e", opacity: 0.6 };
      else delete this.map.water;
      this.rebuildAll();
      this.ui.refresh();
      return;
    }
    if (field === "waterLevel" || field === "waterColor" || field === "waterOpacity") {
      if (!this.map.water) return;
      const key = { waterLevel: "level", waterColor: "color", waterOpacity: "opacity" }[field];
      this.map.water[key] = key === "color" ? value : Math.max(0, value);
      this.rebuildAll();
      return;
    }
    if (field === "borderWalls") {
      this.map.borderWalls = !!value;
      this.rebuildAll();
      return;
    }
    if (field === "fogNear" || field === "fogFar") {
      this.map.fog ||= { color: this.map.background, near: 70, far: 190 };
      this.map.fog[field === "fogNear" ? "near" : "far"] = value;
      if (this.scene.fog) {
        this.scene.fog.near = this.map.fog.near;
        this.scene.fog.far = this.map.fog.far;
      }
    }
  }

  // ---------------------------------------------------------------- outils terrain
  /**
   * Sélectionne l'outil actif : "select" | "sculpt".
   * En sculpt, le clic gauche peint (orbite déplacée sur clic droit).
   */
  setTool(tool) {
    if (tool === "sculpt" && !hasTerrain(this.map.terrain)) tool = "select";
    this.tool = tool;
    this.sculpting = false;
    const needsLeft = tool !== "select";
    if (needsLeft) { this.select(null); this.gizmo?.detach(); }
    if (this.orbit) {
      this.orbit.mouseButtons = needsLeft
        ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    if (this.brushRing) this.brushRing.visible = false; // réapparaît au survol en mode sculpt
    this.ui.refresh();
  }

  /** Point monde sous le curseur (raycast sur le sol), ou null. */
  _groundPoint(e) {
    if (!this.baseEnv?.floor) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._ray.setFromCamera(this._pointer, this.camera);
    const hit = this._ray.intersectObject(this.baseEnv.floor, false)[0];
    return hit ? hit.point.clone() : null;
  }

  /** Place/redimensionne l'anneau d'aperçu du pinceau sous le curseur. */
  _updateBrushRing(e) {
    if (!this.brushRing) return;
    const pt = this._groundPoint(e);
    if (!pt) { this.brushRing.visible = false; return; }
    this.brushRing.visible = true;
    this.brushRing.position.set(pt.x, pt.y + 0.05, pt.z);
    this.brushRing.scale.setScalar(this.brushRadius);
  }

  /** Applique le pinceau au point survolé (dir = +1 monter, -1 creuser). */
  _sculptAt(e, dir) {
    const t = this.map.terrain;
    if (!hasTerrain(t)) return;
    const pt = this._groundPoint(e);
    if (!pt) return;
    const cx = pt.x, cz = pt.z;
    const seg = t.seg, n = seg + 1, half = t.size / 2, cell = t.size / seg;
    const R = this.brushRadius, str = this.brushStrength;
    const mode = this.brushMode || "raise";
    const targetH = sampleTerrainHeight(t, cx, cz); // pour "aplanir"
    const src = mode === "smooth" ? t.heights.slice() : null;
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = -half + ix * cell, wz = -half + iy * cell;
        const dd = Math.hypot(wx - cx, wz - cz);
        if (dd > R) continue;
        const fall = 0.5 * (1 + Math.cos(Math.PI * dd / R)); // dégradé doux (cosine)
        const i = iy * n + ix;
        if (mode === "raise") {
          t.heights[i] += str * dir * fall;
        } else if (mode === "flatten") {
          t.heights[i] += (targetH - t.heights[i]) * Math.min(1, str * fall);
        } else if (mode === "smooth") {
          const up = src[Math.max(0, iy - 1) * n + ix], dn = src[Math.min(n - 1, iy + 1) * n + ix];
          const lf = src[iy * n + Math.max(0, ix - 1)], rt = src[iy * n + Math.min(n - 1, ix + 1)];
          const avg = (up + dn + lf + rt) / 4;
          t.heights[i] += (avg - t.heights[i]) * Math.min(1, str * fall);
        }
      }
    }
    this._deformFloor();
  }

  /** Réécrit la géométrie du sol depuis la heightmap courante. */
  _deformFloor() {
    const t = this.map.terrain, f = this.baseEnv?.floor;
    if (!hasTerrain(t) || !f) return;
    const n = t.seg + 1;
    const pos = f.geometry.attributes.position;
    for (let i = 0; i < n * n; i++) pos.setZ(i, t.heights[i]);
    pos.needsUpdate = true;
    f.geometry.computeVertexNormals();
  }

  // ---------------------------------------------------------------- animateur
  /** Ouvre la fenêtre d'animation pour le cover donné (crée le clip si absent). */
  openAnimator(obj) {
    if (!obj || obj.kind !== "cover") return;
    this.pushHistory();
    obj.data.anim = migrateToClip(obj.data.anim);
    this._animObj = obj;
    this.animator.open(obj.data.anim, {
      title: "Bloc",
      onChange: () => {},                 // mutation en place (snapshot pris à l'ouverture)
      onClose: () => { this._animObj = null; },
    });
  }

  removeAnimation(obj) {
    if (!obj) return;
    this.pushHistory();
    delete obj.data.anim;
    if (this._animObj === obj) this.animator.close();
    this.ui.showProperties(obj);
  }

  // ---------------------------------------------------------------- outils
  addCover() {
    this.pushHistory();
    const data = { pos: [0, 1, 0], size: [4, 2, 4], accent: false, rot: 0 };
    this.map.covers.push(data);
    const o = this._addCoverMesh(data);
    this.select(o);
    this.ui.refresh();
  }

  addSpawn() {
    this.pushHistory();
    this.map.spawns.push([0, PLAYER_H, 0]);
    const o = this._addSpawnMesh(this.map.spawns.length - 1);
    this.select(o);
    this.ui.refresh();
  }

  addPickup() {
    this.pushHistory();
    const n = this.map.pickups.length + 1;
    const data = { id: `heal_${this.map.id || "map"}_${n}`, type: "heal", pos: [0, PLAYER_H, 0], healAmount: 35 };
    this.map.pickups.push(data);
    const o = this._addPickupMesh(data);
    this.select(o);
    this.ui.refresh();
  }

  duplicateSelected() {
    const o = this.selected;
    if (!o) return;
    this.pushHistory();
    if (o.kind === "cover") {
      const data = deepClone(o.data); data.pos[0] += 2; data.pos[2] += 2;
      this.map.covers.push(data);
      this.select(this._addCoverMesh(data));
    } else if (o.kind === "pickup") {
      const data = deepClone(o.data); data.pos[0] += 2; data.id += "_copy";
      this.map.pickups.push(data);
      this.select(this._addPickupMesh(data));
    } else if (o.kind === "spawn") {
      const s = this.map.spawns[o.index].slice(); s[0] += 2; s[2] += 2;
      this.map.spawns.push(s);
      this.select(this._addSpawnMesh(this.map.spawns.length - 1));
    }
    this.ui.refresh();
  }

  deleteSelected() {
    const o = this.selected;
    if (!o) return;
    if (o.kind === "spawn" && this.map.spawns.length <= 2) {
      this.ui.toast("Il faut au moins 2 points d'apparition.");
      return;
    }
    this.pushHistory();
    if (o.kind === "cover") this.map.covers.splice(this.map.covers.indexOf(o.data), 1);
    else if (o.kind === "pickup") this.map.pickups.splice(this.map.pickups.indexOf(o.data), 1);
    else if (o.kind === "spawn") this.map.spawns.splice(o.index, 1);
    else if (o.kind === "endpoint") this._pairArr(o.ref.type).splice(o.ref.index, 1); // supprime la paire
    this.select(null);
    this._rebuildObjects();        // réindexe les spawns
    this.ui.refresh();
  }

  addTeleporter() {
    this.pushHistory();
    (this.map.teleporters ||= []).push({ from: [-6, 1.7, 0], to: [6, 1.7, 0], r: 1.4 });
    this._rebuildObjects();
    this.ui.refresh();
  }

  addZipline() {
    this.pushHistory();
    (this.map.ziplines ||= []).push({ a: [-8, 5, 0], b: [8, 1.5, 0], speed: 18, r: 2.2 });
    this._rebuildObjects();
    this.ui.refresh();
  }

  // ---------------------------------------------------------------- assets (glTF)
  async importModelFile(file) {
    try {
      const obj = await loadModelFromFile(file);
      obj.position.set(0, 0, 0);
      this.baseEnv.group.add(obj);
      this._props.push(obj);
      this.ui.toast(`Modèle « ${file.name} » importé (prévisualisation). ` +
        `Placez-le dans public/assets/models/ et référencez-le dans la carte pour le conserver.`);
    } catch (e) {
      this.ui.toast("Échec du chargement du modèle : " + (e?.message || e));
    }
  }

  // ---------------------------------------------------------------- export du modèle de carte
  /** Renvoie une carte prête à être testée/sauvegardée (deep clone validé). */
  getMap(id, name) {
    const out = deepClone(this.map);
    out.version = 1;
    if (id) out.id = id;
    if (name) out.name = name;
    if (!Array.isArray(out.props) || !out.props.length) delete out.props;
    return out;
  }
}

function r(v) { return Math.round(v * 1000) / 1000; }
