import * as THREE from "three";
import { SETTINGS } from "./config.js";
import { toonMat, addOutline } from "./toon.js";

// Représentation visuelle d'un adversaire (bot ou joueur distant).
// Expose des hitboxes corps/tête pour le raycast.
export class Avatar {
  constructor(scene, color = 0xe8433f) {
    this.group = new THREE.Group();
    this.health = 100;
    this.alive = true;

    const bodyMat = toonMat(color, { emissive: color, emissiveIntensity: 0.12 });
    const darkMat = toonMat(0x141a24);

    // Corps (capsule)
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 12), bodyMat);
    this.body.position.y = 0.95;
    this.body.castShadow = true;
    addOutline(this.body, 1.08);
    this.group.add(this.body);

    // Tête
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), bodyMat);
    this.head.position.y = 1.62;
    this.head.castShadow = true;
    addOutline(this.head, 1.12);
    this.group.add(this.head);

    // Visière / indicateur de direction
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.08), darkMat);
    visor.position.set(0, 1.64, 0.24);
    this.head.add(visor);

    // "Arme"
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), darkMat);
    gun.position.set(0.28, 1.0, 0.35);
    this.group.add(gun);

    // Hitboxes (mesh invisibles plus généreuses pour le gameplay)
    this.bodyHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.5, 0.9),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.bodyHit.position.y = 0.85;
    this.bodyHit.userData.zone = "body";
    this.bodyHit.userData.avatar = this;
    this.group.add(this.bodyHit);

    this.headHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.headHit.position.y = 1.62;
    this.headHit.userData.zone = "head";
    this.headHit.userData.avatar = this;
    this.group.add(this.headHit);

    // Barre de vie flottante
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 16;
    this._hpCanvas = canvas; this._hpCtx = canvas.getContext("2d");
    this._hpTex = new THREE.CanvasTexture(canvas);
    this.hpBar = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._hpTex, depthTest: false }));
    this.hpBar.position.y = 2.15;
    this.hpBar.scale.set(1.4, 0.18, 1);
    this.group.add(this.hpBar);
    this._drawHp(1);

    scene.add(this.group);
    this.hitMeshes = [this.bodyHit, this.headHit];
  }

  _drawHp(frac) {
    const c = this._hpCtx;
    c.clearRect(0, 0, 128, 16);
    c.fillStyle = "rgba(0,0,0,0.6)"; c.fillRect(0, 0, 128, 16);
    c.fillStyle = frac > 0.5 ? "#38ef7d" : frac > 0.25 ? "#ffb142" : "#ff2e63";
    c.fillRect(2, 2, 124 * Math.max(0, frac), 12);
    this._hpTex.needsUpdate = true;
  }

  setClassColor(classId) {
    const map = { assault: 0xff9e2c, scout: 0xffc14d, sniper: 0xe8433f };
    const col = map[classId] ?? 0xe8433f;
    this.body.material.color.setHex(col);
    this.body.material.emissive.setHex(col);
    this.head.material.color.setHex(col);
  }

  setHealthMax(h) { this.maxHealth = h; this.health = h; }

  takeDamage(amount) {
    if (!this.alive) return false;
    this.health -= amount;
    this._drawHp(this.health / (this.maxHealth || 100));
    if (this.health <= 0) { this.health = 0; this.alive = false; return true; }
    return false;
  }

  setPosition(x, y, z) {
    // y reçu = position des yeux ; le groupe est posé aux pieds
    this.group.position.set(x, y - SETTINGS.playerHeight, z);
  }

  setYaw(yaw) { this.group.rotation.y = yaw + Math.PI; }

  respawn(pos, maxHealth) {
    this.alive = true;
    this.health = maxHealth ?? this.maxHealth ?? 100;
    this.maxHealth = this.health;
    this._drawHp(1);
    this.group.visible = true;
    this.setPosition(pos.x, pos.y, pos.z);
  }

  setVisible(v) { this.group.visible = v; }
}
