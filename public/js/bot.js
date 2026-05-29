import * as THREE from "three";
import { SETTINGS, WEAPONS } from "./config.js";
import { sampleTerrainHeight } from "./terrain.js";

// IA d'entraînement : pilote un Avatar. Approche, garde ses distances, strafe, tire en ligne de vue.
export class Bot {
  constructor(avatar, env, difficulty = 0.65) {
    this.av = avatar;
    this.env = env;            // { colliders, solids }
    this.diff = difficulty;    // 0..1 précision/agressivité
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.radius = 0.45;
    this.strafeDir = 1;
    this.strafeT = 0;
    this.preferredDist = 13;   // distance d'engagement (varie dans le temps)
    this.distT = 0;
    this.fireCd = 0;
    this.weapon = WEAPONS.rifle;
    this.onShoot = null;       // (origin, dir, didHit, damage) => {}
  }

  spawn(pos) {
    this.pos.copy(pos);
    // yeux = sol (terrain) + hauteur du joueur → le bot repose sur le relief.
    this.pos.y = sampleTerrainHeight(this.env.terrain, pos.x, pos.z) + SETTINGS.playerHeight;
    this.vel.set(0, 0, 0);
    this.av.respawn({ x: pos.x, y: this.pos.y, z: pos.z }, this.av.maxHealth);
  }

  update(dt, targetPos, targetAlive) {
    if (!this.av.alive) return;

    const toT = new THREE.Vector3().subVectors(targetPos, this.pos);
    toT.y = 0;
    const dist = toT.length();
    toT.normalize();
    this.yaw = Math.atan2(toT.x, toT.z);

    // strafe oscillant
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = 0.8 + Math.random() * 1.2; }
    const rightV = new THREE.Vector3(toT.z, 0, -toT.x);

    // distance d'engagement variable : avance/recule pour la tenir
    this.distT -= dt;
    if (this.distT <= 0) { this.preferredDist = 9 + Math.random() * 9; this.distT = 2 + Math.random() * 2.5; }
    let approach = 0;
    if (dist > this.preferredDist + 1.5) approach = 1;
    else if (dist < this.preferredDist - 1.5) approach = -1;

    const speed = SETTINGS.moveSpeed * (0.7 + this.diff * 0.4);
    const wish = new THREE.Vector3()
      .addScaledVector(toT, approach)
      .addScaledVector(rightV, this.strafeDir * 0.7);

    // À basse vie : se replier vers la couverture la plus proche
    const lowHp = this.av.health < (this.av.maxHealth || 100) * 0.35;
    if (lowHp && this.env.coverPoints && this.env.coverPoints.length) {
      let nearest = null, nd = Infinity;
      for (const c of this.env.coverPoints) {
        const d = c.distanceToSquared(this.pos);
        if (d < nd && d > 1) { nd = d; nearest = c; }
      }
      if (nearest) {
        const toC = new THREE.Vector3().subVectors(nearest, this.pos); toC.y = 0;
        if (toC.lengthSq() > 0.5) wish.addScaledVector(toC.normalize(), 1.3);
      }
    }
    if (wish.lengthSq() > 0) wish.normalize();

    this.vel.x = wish.x * speed;
    this.vel.z = wish.z * speed;

    this._step("x", this.vel.x * dt);
    this._step("z", this.vel.z * dt);

    // garder dans l'arène
    const lim = SETTINGS.arenaSize / 2 - 2;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));
    // suit le relief du terrain sous lui
    this.pos.y = sampleTerrainHeight(this.env.terrain, this.pos.x, this.pos.z) + SETTINGS.playerHeight;

    this.av.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.av.setYaw(this.yaw + Math.PI);

    // --- Tir ---
    if (this.fireCd > 0) this.fireCd -= dt;
    if (targetAlive && this.fireCd <= 0 && this._hasLineOfSight(targetPos)) {
      this.fireCd = (1 / (this.weapon.fireRate * 0.35)) + Math.random() * 0.25;
      const origin = this.pos.clone();
      const dir = new THREE.Vector3().subVectors(targetPos, origin).normalize();
      // précision selon difficulté et distance
      const hitChance = Math.max(0.12, this.diff - dist * 0.012);
      const didHit = Math.random() < hitChance;
      const dmg = this.weapon.damage * (0.8 + Math.random() * 0.4);
      if (this.onShoot) this.onShoot(origin, dir, didHit, dmg);
    }
  }

  _hasLineOfSight(targetPos) {
    const origin = this.pos.clone();
    const dir = new THREE.Vector3().subVectors(targetPos, origin);
    const dist = dir.length();
    dir.normalize();
    const ray = new THREE.Raycaster(origin, dir, 0.5, dist - 0.5);
    const hits = ray.intersectObjects(this.env.solids, false);
    return hits.length === 0;
  }

  _step(axis, delta) {
    this.pos[axis] += delta;
    const r = this.radius, px = this.pos.x, pz = this.pos.z;
    const feet = this.pos.y - SETTINGS.playerHeight, head = this.pos.y;
    for (const box of this.env.colliders) {
      if (head < box.min.y || feet > box.max.y) continue;
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
        if (axis === "x") this.pos.x = delta > 0 ? minX : maxX;
        else this.pos.z = delta > 0 ? minZ : maxZ;
        return;
      }
    }
  }
}
