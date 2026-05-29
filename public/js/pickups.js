import * as THREE from "three";

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeHealMesh() {
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 0.25, 12),
    new THREE.MeshStandardMaterial({ color: 0x4cc46a, emissive: 0x183b22, roughness: 0.35, metalness: 0.1 })
  );
  core.castShadow = true;
  core.position.y = 0.2;
  group.add(core);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.35, 0.06, 10, 22),
    new THREE.MeshStandardMaterial({ color: 0xfff4d8, emissive: 0x1a160d, roughness: 0.25, metalness: 0.2 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.32;
  group.add(ring);

  const plusMat = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.85, metalness: 0.05 });
  const barA = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.1), plusMat);
  const barB = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, 0.1), plusMat);
  barA.position.y = 0.34;
  barB.position.y = 0.34;
  group.add(barA, barB);

  group.userData = { ring };
  return group;
}

/**
 * Gère des pickups "heal" (rendu + respawn local).
 * En online, le serveur pilote l'état via `initFromServer()` + `markTaken()`.
 */
export class PickupsManager {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, { id: string, type: 'heal', pos: THREE.Vector3, group: THREE.Group, active: boolean, respawnAtMs: number, healAmount: number }>} */
    this._items = new Map();
    this._t = 0;
  }

  dispose() {
    for (const it of this._items.values()) this.scene.remove(it.group);
    this._items.clear();
  }

  /**
   * @param {{ id: string, type: 'heal', x: number, y: number, z: number, healAmount?: number, active?: boolean, respawnAtMs?: number }[]} list
   */
  initFromServer(list) {
    // Remplace l'état complet (au démarrage du match).
    this.dispose();
    for (const p of list || []) {
      if (!p || p.type !== "heal") continue;
      const id = String(p.id);
      const pos = new THREE.Vector3(p.x, p.y, p.z);
      const group = makeHealMesh();
      group.position.copy(pos);
      group.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(group);
      this._items.set(id, {
        id,
        type: "heal",
        pos,
        group,
        active: p.active !== false,
        respawnAtMs: typeof p.respawnAtMs === "number" ? p.respawnAtMs : 0,
        healAmount: typeof p.healAmount === "number" ? p.healAmount : 35,
      });
      group.visible = p.active !== false;
    }
  }

  /**
   * Utilisé en solo (création locale).
   * @param {{ id: string, x: number, y: number, z: number, healAmount?: number }[]} list
   */
  initLocal(list) {
    const payload = (list || []).map((p) => ({
      id: String(p.id),
      type: "heal",
      x: p.x,
      y: p.y,
      z: p.z,
      healAmount: typeof p.healAmount === "number" ? p.healAmount : 35,
      active: true,
      respawnAtMs: 0,
    }));
    this.initFromServer(payload);
  }

  /**
   * @param {string} id
   * @param {{ respawnInMs?: number }=} opts
   */
  markTaken(id, opts) {
    const it = this._items.get(String(id));
    if (!it) return;
    const respawnInMs = typeof opts?.respawnInMs === "number" ? opts.respawnInMs : 10_000;
    if (respawnInMs <= 0) {
      it.active = true;
      it.respawnAtMs = 0;
      it.group.visible = true;
      return;
    }
    it.active = false;
    it.group.visible = false;
    it.respawnAtMs = Date.now() + clamp(respawnInMs, 250, 120_000);
  }

  update(dt) {
    this._t += dt;
    const now = Date.now();
    for (const it of this._items.values()) {
      // Respawn local (solo) ou pour refléter l'info serveur.
      if (!it.active && it.respawnAtMs > 0 && now >= it.respawnAtMs) {
        it.active = true;
        it.respawnAtMs = 0;
        it.group.visible = true;
      }

      if (!it.group.visible) continue;
      it.group.position.y = it.pos.y + 0.12 + Math.sin(this._t * 2.6 + it.pos.x * 0.2) * 0.06;
      it.group.rotation.y += dt * 0.9;
      const ring = it.group.userData.ring;
      if (ring) ring.rotation.z += dt * 1.6;
    }
  }

  /**
   * Collecte locale (solo). Retourne l'amount soigné (0 si rien).
   * @param {{ pos: THREE.Vector3, health: number, maxHealth: number, heal: (amount: number) => number, alive: boolean }} player
   */
  tryCollectSolo(player) {
    if (!player?.alive) return 0;
    if (player.health >= player.maxHealth) return 0;
    for (const it of this._items.values()) {
      if (!it.active || !it.group.visible) continue;
      const d2 = player.pos.distanceToSquared(it.pos);
      if (d2 <= 1.0 * 1.0) {
        const gained = player.heal(it.healAmount);
        if (gained > 0) this.markTaken(it.id, { respawnInMs: 10_000 });
        return gained;
      }
    }
    return 0;
  }
}

