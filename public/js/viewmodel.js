import * as THREE from "three";
import { WEAPONS } from "./config.js";
import { toonMat, addOutline } from "./toon.js";
import { hasAnim, sampleAnim } from "./anim.js";

// Dimensions par arme (longueur du corps, présence d'une lunette, etc.)
const SHAPE = {
  rifle:    { len: 0.52, h: 0.10, scope: false },
  smg:      { len: 0.40, h: 0.11, scope: false },
  sniper:   { len: 0.74, h: 0.09, scope: true },
  shotgun:  { len: 0.54, h: 0.13, scope: false },
  dmr:      { len: 0.62, h: 0.10, scope: true },
  lmg:      { len: 0.58, h: 0.15, scope: false },
  pistol:   { len: 0.24, h: 0.12, scope: false },
  machpist: { len: 0.28, h: 0.12, scope: false },
  revolver: { len: 0.26, h: 0.13, scope: false },
};

const HIP = new THREE.Vector3(0.22, -0.20, -0.50);
const ADS = new THREE.Vector3(0.0, -0.105, -0.34);

// Arme tenue en vue FPS, enfant de la caméra.
export class ViewModel {
  constructor(camera) {
    this.camera = camera;
    this.group = new THREE.Group();
    camera.add(this.group);

    this.curPos = HIP.clone();
    this.bobT = 0;
    this.bobAmt = 0;
    this.kick = 0;
    this.reloadA = 0;
    this.currentId = null;

    // Clips d'animation custom par événement (idle/fire/reload/equip), depuis weapons.json
    this.clips = null;
    this._idleT = 0;          // horloge du clip idle (boucle)
    this._osClip = null;      // clip one-shot en cours (fire/reload/equip)
    this._osT = 0;
    this._wasReloading = false;

    // Muzzle flash : plan additif + lumière
    this.flashMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.group.add(this.flashMesh);
    this.flashLight = new THREE.PointLight(0xffcf80, 0, 6);
    this.group.add(this.flashLight);
    this.flash = 0;
  }

  _clearWeaponMeshes() {
    // retire tout sauf le flash + la lumière
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const c = this.group.children[i];
      if (c !== this.flashMesh && c !== this.flashLight) {
        this.group.remove(c);
        c.traverse?.((o) => { if (o.isMesh && o.geometry) o.geometry.dispose?.(); });
      }
    }
  }

  setWeapon(id, tint) {
    this.currentId = id;
    this._clearWeaponMeshes();
    // Modèle 3D custom (GLB) si l'arme en déclare un : weapons.json → viewModel:{model,scale,pos,rot,muzzle}
    const cfg = WEAPONS[id]?.viewModel;
    // Clips d'animation + jouer l'animation d'équipement.
    this.clips = cfg?.clips || null;
    this._idleT = 0; this._osT = 0;
    this._osClip = this.clips?.equip && hasAnim(this.clips.equip) ? this.clips.equip : null;
    this._modelToken = (this._modelToken || 0) + 1;
    if (cfg && cfg.model) {
      this._buildProcedural(id, tint);   // fallback affiché pendant le chargement
      const token = this._modelToken;
      import("./editor/assets.js")
        .then(({ loadModel }) => loadModel(cfg.model))
        .then((obj) => {
          if (token !== this._modelToken) return;   // arme changée entre-temps
          this._clearWeaponMeshes();
          const sc = typeof cfg.scale === "number" ? cfg.scale : 1;
          obj.scale.setScalar(sc);
          const [px, py, pz] = cfg.pos || [0.18, -0.18, -0.40];
          obj.position.set(px, py, pz);
          const [rx, ry, rz] = cfg.rot || [0, 0, 0];
          obj.rotation.set(rx, ry, rz);
          this.group.add(obj);
          const [mx, my, mz] = cfg.muzzle || [px, py, pz - 0.5 * sc];
          this._muzzleY = my;
          this._muzzleZ = mz;
          this.flashMesh.position.set(mx, my, mz);
          this.flashLight.position.set(mx, my, mz);
        })
        .catch((e) => console.warn("[viewmodel] modèle d'arme introuvable :", cfg.model, e?.message || e));
      return;
    }
    this._buildProcedural(id, tint);
  }

  _buildProcedural(id, tint) {
    const s = SHAPE[id] || SHAPE.rifle;
    const dark = toonMat(0x15181d);
    const accent = toonMat(tint, { emissive: tint, emissiveIntensity: 0.15 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, s.h, s.len), dark);
    body.position.set(0, 0, -s.len / 2);
    addOutline(body, 1.08);
    this.group.add(body);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, s.len * 0.5, 8), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, s.h * 0.15, -s.len - s.len * 0.12);
    this.group.add(barrel);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), accent);
    mag.position.set(0, -s.h - 0.02, -s.len * 0.45);
    this.group.add(mag);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), dark);
    grip.position.set(0, -s.h * 0.6 - 0.04, -s.len * 0.12);
    grip.rotation.x = -0.3;
    this.group.add(grip);

    if (s.scope) {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 10), accent);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, s.h * 0.7, -s.len * 0.5);
      this.group.add(scope);
    }

    // position du canon (pour le flash)
    this._muzzleZ = -s.len - s.len * 0.38;
    this._muzzleY = s.h * 0.15;
    this.flashMesh.position.set(0, this._muzzleY, this._muzzleZ);
    this.flashLight.position.set(0, this._muzzleY, this._muzzleZ);
  }

  fire() {
    if (this.clips?.fire && hasAnim(this.clips.fire)) { this._osClip = this.clips.fire; this._osT = 0; }
    this.kick = Math.min(1, this.kick + 0.7);
    this.flash = 1;
    this.flashMesh.rotation.z = Math.random() * Math.PI;
    this.flashMesh.scale.setScalar(0.8 + Math.random() * 0.6);
  }

  update(dt, player, adsActive) {
    const id = player.weaponState.id;
    if (id !== this.currentId) {
      // tint importé paresseusement pour éviter cycle
      this.setWeapon(id, this._tintFor ? this._tintFor(id) : WEAPONS[id].color);
    }

    // bob de déplacement (désactivé en slide, vitesse plafonnée → pas de tremblement)
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const moving = speed > 1 && player.onGround && !player.sliding;
    const bobSpeed = Math.min(speed, 7);
    this.bobAmt += ((moving ? 1 : 0) - this.bobAmt) * Math.min(1, dt * 8); // fondu doux
    this.bobT += dt * bobSpeed * 1.4 * this.bobAmt;
    const bobX = Math.cos(this.bobT) * 0.012 * this.bobAmt;
    const bobY = Math.abs(Math.sin(this.bobT)) * 0.014 * this.bobAmt;

    // recharge : on baisse l'arme
    const reloading = player.weaponState.reloading;
    this.reloadA += ((reloading ? 1 : 0) - this.reloadA) * Math.min(1, dt * 10);

    // cible de position (ADS centre vs hanche) + recul + bob + dip recharge
    const target = (adsActive ? ADS : HIP).clone();
    this.curPos.lerp(target, Math.min(1, dt * 14));

    this.kick = Math.max(0, this.kick - dt * 6);

    this.group.position.set(
      this.curPos.x + bobX,
      this.curPos.y + bobY - this.reloadA * 0.18,
      this.curPos.z + this.kick * 0.05
    );
    this.group.rotation.x = this.kick * 0.18 + this.reloadA * 0.8;
    this.group.rotation.z = this.reloadA * 0.5;

    // Clips d'animation custom (par-dessus la pose procédurale).
    if (this.clips) this._applyClips(dt, reloading);

    // muzzle flash
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 22);
      this.flashMesh.material.opacity = this.flash;
      this.flashLight.intensity = this.flash * 4;
      this.flashMesh.lookAt(this.camera.position);
    }
  }

  _applyClips(dt, reloading) {
    // déclenche le clip de recharge au début d'une recharge
    if (reloading && !this._wasReloading && this.clips.reload && hasAnim(this.clips.reload)) {
      this._osClip = this.clips.reload; this._osT = 0;
    }
    this._wasReloading = reloading;

    let p = [0, 0, 0], r = [0, 0, 0], s = 1;
    // idle en boucle (baseline)
    if (this.clips.idle && hasAnim(this.clips.idle)) {
      this._idleT += dt;
      const o = sampleAnim(this.clips.idle, this._idleT);
      p = [o.p[0], o.p[1], o.p[2]]; r = [o.r[0], o.r[1], o.r[2]]; s *= o.s ?? 1;
    }
    // one-shot (fire/reload/equip) en surcouche
    if (this._osClip) {
      this._osT += dt;
      const o = sampleAnim(this._osClip, this._osT);
      p = [p[0] + o.p[0], p[1] + o.p[1], p[2] + o.p[2]];
      r = [r[0] + o.r[0], r[1] + o.r[1], r[2] + o.r[2]];
      s *= o.s ?? 1;
      if (this._osT >= (this._osClip.dur || 1)) this._osClip = null; // one-shot terminé
    }
    this.group.position.x += p[0]; this.group.position.y += p[1]; this.group.position.z += p[2];
    this.group.rotation.x += r[0]; this.group.rotation.y += r[1]; this.group.rotation.z += r[2];
    this.group.scale.setScalar(s);
  }

  dispose() {
    this.camera.remove(this.group);
  }
}
