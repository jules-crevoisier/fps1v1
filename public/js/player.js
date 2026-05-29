import * as THREE from "three";
import { SETTINGS, WEAPONS, CLASSES, USER } from "./config.js";
import { sampleTerrainHeight } from "./terrain.js";

const UP = new THREE.Vector3(0, 1, 0);

// Joueur local : déplacement type Apex (sprint/slide/saut), collisions, gestion d'armes.
export class Player {
  constructor(camera, loadout) {
    this.camera = camera;
    this.setLoadout(loadout);

    this.pos = new THREE.Vector3();   // position de l'œil (caméra)
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.radius = 0.4;

    this.onGround = false;
    this.sliding = false;
    this.slideTimer = 0;
    this.slideStartSpeed = 0;  // vitesse au déclenchement (pour la décroissance)
    this.slideCd = 0;          // cooldown avant re-slide
    this.slideKeyWasDown = false; // détection de front montant (re-presser pour re-slider)
    this.height = SETTINGS.playerHeight;

    this.fireCd = 0;
    this.recoilPitch = 0;     // kick vertical courant (offset de visée)
    this.recoilYaw = 0;       // kick horizontal courant
    this.shake = 0;           // screenshake courant
    this.invuln = 0;          // invincibilité au respawn (s)
    this.alive = true;

    // callback déclenché à chaque balle : (origin, dir, weapon) => {}
    this.onShoot = null;
  }

  setLoadout(loadout) {
    this.loadout = loadout;
    this.classId = loadout.classId;
    this.cls = CLASSES[loadout.classId];
    this.maxHealth = this.cls.health;
    this.health = this.maxHealth;
    this.weapons = [loadout.primary, loadout.secondary].map((id) => ({
      id, ammo: WEAPONS[id].mag, reloading: false, reloadT: 0,
    }));
    this.weaponIndex = 0;
  }

  get weapon() { return WEAPONS[this.weapons[this.weaponIndex].id]; }
  get weaponState() { return this.weapons[this.weaponIndex]; }

  spawn(position, yaw = 0) {
    this.pos.copy(position);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.sliding = false; this.slideCd = 0; this.slideKeyWasDown = false;
    this.height = SETTINGS.playerHeight;
    this.weapons.forEach((w) => { w.ammo = WEAPONS[w.id].mag; w.reloading = false; w.reloadT = 0; });
  }

  switchWeapon(index) {
    if (index < 0 || index >= this.weapons.length || index === this.weaponIndex) return;
    this.weaponIndex = index;
    this.weaponState.reloading = false; this.weaponState.reloadT = 0;
  }

  reload() {
    const ws = this.weaponState;
    if (ws.reloading || ws.ammo === this.weapon.mag) return;
    ws.reloading = true;
    ws.reloadT = this.weapon.reload;
  }

  takeDamage(amount) {
    if (!this.alive || this.invuln > 0) return false;
    this.health -= amount;
    if (this.health <= 0) { this.health = 0; this.alive = false; return true; }
    return false;
  }

  heal(amount) {
    if (!this.alive) return 0;
    const a = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
    if (a <= 0) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + a);
    return this.health - before;
  }

  update(dt, input, env) {
    if (!this.alive) return;
    if (this.invuln > 0) this.invuln -= dt;

    // --- Visée ---
    this.ads = input.adsDown && input.locked;
    const [dx, dy] = input.consumeMouse();
    const sens = SETTINGS.mouseSensitivity * USER.sensitivity * (this.ads ? 0.55 : 1);
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));

    // Recovery du recul : le kick revient vers 0 (feeling arcade, visée rendue)
    const rec = Math.min(1, dt * 9);
    this.recoilPitch += (0 - this.recoilPitch) * rec;
    this.recoilYaw += (0 - this.recoilYaw) * rec;
    this.shake *= Math.max(0, 1 - dt * 14);

    this._move(dt, input, env);
    this._weapons(dt, input, env);

    // Applique à la caméra (visée + recul + screenshake)
    this.camera.position.copy(this.pos);
    if (this.shake > 0.0005) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
    }
    const dir = this._lookDir();
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  // Direction de visée = base + recul (clampée)
  _lookDir() {
    const yaw = this.yaw + this.recoilYaw;
    const pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch + this.recoilPitch));
    return new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    ).normalize();
  }

  _move(dt, input, env) {
    // Directions horizontales relatives au yaw
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3().crossVectors(fwd, UP); // droite réelle de l'écran

    let ix = 0, iz = 0;
    if (input.down("KeyW") || input.down("ArrowUp")) iz += 1;
    if (input.down("KeyS") || input.down("ArrowDown")) iz -= 1;
    if (input.down("KeyD") || input.down("ArrowRight")) ix += 1;
    if (input.down("KeyA") || input.down("KeyQ") || input.down("ArrowLeft")) ix -= 1;

    const wish = new THREE.Vector3()
      .addScaledVector(fwd, iz)
      .addScaledVector(right, ix);
    if (wish.lengthSq() > 0) wish.normalize();

    // Sprint par DÉFAUT ; Alt = marcher (lent et silencieux)
    const walking = input.down("AltLeft") || input.down("AltRight");
    const wantSlide = input.down("ControlLeft") || input.down("KeyC");

    const sprintSpeed = SETTINGS.moveSpeed * this.cls.speedMult * SETTINGS.sprintMult;
    let speed = SETTINGS.moveSpeed * this.cls.speedMult * (walking ? 0.5 : SETTINGS.sprintMult);

    if (this.slideCd > 0) this.slideCd -= dt;

    // --- Slide façon COD ---
    // Déclenché sur un FRONT MONTANT de la touche (re-presser pour re-slider),
    // uniquement lancé (≈ sprint), au sol, sans cooldown actif. On ne peut pas le
    // prolonger en maintenant la touche : sa durée est fixe.
    const slideKeyPressed = wantSlide && !this.slideKeyWasDown; // front montant
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    const canSlide =
      this.onGround && !walking && !this.sliding && this.slideCd <= 0 &&
      wish.lengthSq() > 0 && horizSpeed >= sprintSpeed * SETTINGS.slideMinSpeedMult;

    if (slideKeyPressed && canSlide) {
      this.sliding = true;
      this.slideTimer = SETTINGS.slideDuration;
      // burst : direction de la visée si on pousse vers l'avant, sinon direction du wish
      const dir = wish.clone().normalize();
      this.slideStartSpeed = sprintSpeed * SETTINGS.slideSpeedMult;
      this.vel.x = dir.x * this.slideStartSpeed;
      this.vel.z = dir.z * this.slideStartSpeed;
    }

    if (this.sliding) {
      this.slideTimer -= dt;
      // Décroissance lissée du burst vers la vitesse de fin (puis crouch-walk).
      const endSpeed = sprintSpeed * SETTINGS.slideEndSpeedMult;
      const t = Math.max(0, this.slideTimer / SETTINGS.slideDuration); // 1 → 0
      const targetSpeed = endSpeed + (this.slideStartSpeed - endSpeed) * (t * t); // ease-out
      const cur = Math.hypot(this.vel.x, this.vel.z) || 1;
      const dirX = this.vel.x / cur, dirZ = this.vel.z / cur;
      // léger contrôle directionnel (steer) sans relancer la vitesse
      this.vel.x += wish.x * SETTINGS.slideSteer * dt;
      this.vel.z += wish.z * SETTINGS.slideSteer * dt;
      const cur2 = Math.hypot(this.vel.x, this.vel.z) || 1;
      this.vel.x = (this.vel.x / cur2) * targetSpeed;
      this.vel.z = (this.vel.z / cur2) * targetSpeed;
      this.height += (SETTINGS.crouchHeight - this.height) * Math.min(1, dt * 12);
      // Fin : durée écoulée, en l'air. Relâcher/maintenir n'y change rien,
      // mais relâcher tôt coupe le slide (annulation volontaire).
      if (this.slideTimer <= 0 || !this.onGround || !wantSlide) {
        this.sliding = false;
        this.slideCd = SETTINGS.slideCooldown;
      }
    } else {
      this.height += (SETTINGS.playerHeight - this.height) * Math.min(1, dt * 12);
      // contrôle au sol vs en l'air
      const control = this.onGround ? 1 : SETTINGS.airControl;
      const target = wish.clone().multiplyScalar(speed);
      this.vel.x += (target.x - this.vel.x) * control * Math.min(1, dt * 12);
      this.vel.z += (target.z - this.vel.z) * control * Math.min(1, dt * 12);
    }

    // --- Saut + gravité ---
    if ((input.down("Space")) && this.onGround) {
      this.vel.y = SETTINGS.jumpForce;
      this.onGround = false;
      if (this.sliding) { this.sliding = false; this.slideCd = SETTINGS.slideCooldown; }
    }
    this.vel.y -= SETTINGS.gravity * dt;

    // --- Intégration + collisions (axes séparés) ---
    this._integrateAxis("x", this.vel.x * dt, env.colliders);
    this._integrateAxis("z", this.vel.z * dt, env.colliders);

    // Vertical — le sol suit le terrain (heightmap) sous le joueur ; yeux = sol + hauteur.
    const ground = sampleTerrainHeight(env.terrain, this.pos.x, this.pos.z);
    const floorEye = ground + this.height;
    this.pos.y += this.vel.y * dt;
    // Au sol et en chute : la caméra (yeux = pos.y) suit la hauteur courante,
    // qui s'abaisse pendant le slide → vraie descente fluide de la vue.
    if (this.onGround && this.vel.y <= 0) this.pos.y = floorEye;
    if (this.pos.y <= floorEye) {
      this.pos.y = floorEye;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Mémorise l'état de la touche slide pour la détection de front montant.
    this.slideKeyWasDown = wantSlide;
  }

  _integrateAxis(axis, delta, colliders) {
    this.pos[axis] += delta;
    const r = this.radius;
    const px = this.pos.x, pz = this.pos.z;
    const feet = this.pos.y - this.height;        // y des pieds
    const head = this.pos.y;                       // y des yeux ~ haut
    for (const box of colliders) {
      // recouvrement vertical du joueur avec le box ?
      if (head < box.min.y || feet > box.max.y) continue;
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
        // pénétration : repousser le long de l'axe courant
        if (axis === "x") {
          this.pos.x = delta > 0 ? minX : maxX;
          this.vel.x = 0;
        } else {
          this.pos.z = delta > 0 ? minZ : maxZ;
          this.vel.z = 0;
        }
        return;
      }
    }
  }

  _weapons(dt, input, env) {
    const ws = this.weaponState;
    if (this.fireCd > 0) this.fireCd -= dt;

    // recharge
    if (ws.reloading) {
      ws.reloadT -= dt;
      if (ws.reloadT <= 0) { ws.reloading = false; ws.ammo = this.weapon.mag; }
    }

    if (input.down("KeyR")) this.reload();
    if (input.down("Digit1")) this.switchWeapon(0);
    if (input.down("Digit2")) this.switchWeapon(1);

    // tir
    const w = this.weapon;
    const firing = input.fireDown && input.locked;
    const wantFire = w.auto ? firing : (firing && !this._firePrev);
    this._firePrev = firing;

    if (wantFire && this.fireCd <= 0 && !ws.reloading && ws.ammo > 0) {
      this._fire(w, ws);
    }
    if (wantFire && ws.ammo === 0 && !ws.reloading) this.reload();
  }

  _fire(w, ws) {
    ws.ammo--;
    this.fireCd = 1 / w.fireRate;

    // IMPORTANT : la balle part à la visée ACTUELLE (le curseur). Le kick de recul
    // est appliqué APRÈS le tir → il décale la vue pour les tirs suivants, pas
    // celui-ci. (Sinon la 1re balle est déviée et le curseur ne sert à rien.)
    const base = this._lookDir();
    const origin = this.pos.clone();
    if (this.onFire) this.onFire(origin, base, w);   // 1× par tir (réseau / son / muzzle)
    const pellets = w.pellets || 1;
    const spread = w.spread * (this.ads ? 0.4 : 1);
    for (let i = 0; i < pellets; i++) {
      const dir = base.clone();
      dir.x += (Math.random() - 0.5) * spread;
      dir.y += (Math.random() - 0.5) * spread;
      dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();
      if (this.onShoot) this.onShoot(origin, dir, w);
    }

    // Kick de recul (après le tir) : vertical franc + horizontal aléatoire + screenshake
    this.recoilPitch += w.recoil;
    this.recoilYaw += (Math.random() - 0.5) * w.recoil * (w.recoilH || 0.5);
    this.shake = Math.min(0.25, this.shake + (w.shake || 0.05));
  }
}
