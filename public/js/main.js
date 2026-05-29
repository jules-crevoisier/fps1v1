import * as THREE from "three";
import { SETTINGS, CLASSES, USER, saveUser, PROFILE, saveProfile, weaponColor, GAMEMODES,
  QUALITY_PRESETS, loadAllData, playerLevel, DEFAULT_KEYBINDS } from "./config.js";
import { steam, ACH } from "./steam.js";
import { Input } from "./input.js";
import { buildArena, MAP_LIST, loadMaps, registerMap, unregisterMap, ensureMap } from "./arena.js";
import { updateAnimated } from "./anim.js";
import { Editor } from "./editor/editor.js";
import { decorateScene } from "./editor/assets.js";
import { listCustomMaps, loadCustomMap } from "./editor/mapStore.js";
import { openWeaponsEditor } from "./editor/weaponsEditor.js";
import { Player } from "./player.js";
import { Avatar } from "./avatar.js";
import { Bot } from "./bot.js";
import { UI } from "./ui.js";
import { Network } from "./network.js";
import { ViewModel } from "./viewmodel.js";
import { audio } from "./audio.js";
import { PickupsManager } from "./pickups.js";

const canvas = document.getElementById("game");
const ui = new UI();
const input = new Input(canvas);
const net = new Network();

let renderer, scene, camera, env, player, oppAvatar, bot, viewmodel;
let pickups = null;
let state = "menu", mode = "solo";
let score = { me: 0, opp: 0 };
let myRespawn = 0, botRespawn = 0;
let oppAlive = true;
const tracers = [];
const clock = new THREE.Clock();
let netAccum = 0, curFov = 90, stepT = 0, wasReloading = false;
let match = { shots: 0, hits: 0, damage: 0, xpStart: 0 };
let gm = GAMEMODES.duel, builtMap = null, roundTimer = 0, onlineSide = 0;
let editor = null, returnToEditor = false, lastTestId = null;
let animTime = 0;   // horloge des objets de carte animés

// ============================ INIT 3D ============================
let rendererAntialias = null;

function currentQuality() { return QUALITY_PRESETS[USER.quality] || QUALITY_PRESETS.high; }

// Applique les réglages qui peuvent changer "à chaud" (sans recréer le contexte WebGL).
function applyRendererQuality(q) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
  renderer.shadowMap.enabled = q.shadows;
}

function onResize() {
  if (!renderer || !camera) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", onResize);

function initRenderer() {
  const q = currentQuality();
  // L'antialiasing ne peut pas changer après création du contexte : on recrée si besoin.
  if (renderer && rendererAntialias === q.antialias) { applyRendererQuality(q); return; }
  if (renderer) renderer.dispose();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: "high-performance" });
  rendererAntialias = q.antialias;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(innerWidth, innerHeight);
  applyRendererQuality(q);
  if (!camera) camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.05, 1000);
}

function buildScene(mapId) {
  if (viewmodel) viewmodel.dispose();
  if (pickups) { pickups.dispose(); pickups = null; }
  scene = new THREE.Scene();
  const q = currentQuality();
  env = buildArena(scene, mapId, { shadows: q.shadows, shadowMapSize: q.shadowMapSize });
  oppAvatar = new Avatar(scene);
  scene.add(camera);                 // pour que le viewmodel (enfant) soit rendu
  viewmodel = new ViewModel(camera);
  viewmodel._tintFor = (id) => weaponColor(id);
  pickups = new PickupsManager(scene);
  builtMap = mapId;
  // Décorations optionnelles (textures de sol / props glTF) : WYSIWYG avec l'éditeur.
  decorateScene(scene, env.map, env).catch(() => {});
}

// Choisit un spawn : le plus loin de `awayFrom` si multi-spawn, sinon index fixe.
function chooseSpawn(awayFrom, fallbackIndex) {
  if (!gm.multiSpawn || !awayFrom) return env.spawns[fallbackIndex].clone();
  let best = env.spawns[0], bestD = -1;
  for (const s of env.spawns) {
    const d = s.distanceToSquared(awayFrom);
    if (d > bestD) { bestD = d; best = s; }
  }
  return best.clone();
}

// ============================ TIR / DÉGÂTS ============================
function spawnTracer(origin, end, color = 0x00e5ff) {
  const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, life: 0.08 });
}

// Marque d'impact sur un mur, orientée selon la normale, qui s'estompe.
const impacts = [];
const _impactGeo = new THREE.CircleGeometry(0.09, 8);
function spawnImpact(point, localNormal, object) {
  const n = localNormal.clone().transformDirection(object.matrixWorld);
  const mesh = new THREE.Mesh(_impactGeo, new THREE.MeshBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.85, depthWrite: false }));
  mesh.position.copy(point).addScaledVector(n, 0.015);
  mesh.lookAt(point.clone().add(n));
  scene.add(mesh);
  impacts.push({ mesh, life: 5 });
  if (impacts.length > 40) { const o = impacts.shift(); scene.remove(o.mesh); o.mesh.material.dispose(); }
}

// Projette un point 3D à l'écran et affiche les dégâts.
function showDamage(worldPos, amount, headshot) {
  const v = worldPos.clone().project(camera);
  if (v.z > 1) return;
  const x = (v.x * 0.5 + 0.5) * innerWidth;
  const y = (-v.y * 0.5 + 0.5) * innerHeight;
  ui.damageNumber(x, y, Math.round(amount), headshot);
}

// 1× par tir : effets + envoi réseau (le serveur résout les dégâts en online).
function onPlayerFire(origin, base, weapon) {
  viewmodel.fire();
  audio.shoot(weapon);
  if (mode === "online") {
    match.shots++;
    net.sendShot({
      ox: origin.x, oy: origin.y, oz: origin.z,
      dir: { x: base.x, y: base.y, z: base.z }, weaponId: player.weaponState.id,
    });
  }
}

// Téléporteurs : entrer dans une zone `from` téléporte le joueur en `to`.
let tpCooldown = 0;
function checkTeleporters(dt) {
  if (tpCooldown > 0) { tpCooldown -= dt; return; }
  const tps = env?.teleporters;
  if (!tps || !tps.length) return;
  for (const tp of tps) {
    const dx = player.pos.x - tp.from[0], dz = player.pos.z - tp.from[2];
    if (dx * dx + dz * dz <= tp.r * tp.r) {
      player.pos.set(tp.to[0], tp.to[1], tp.to[2]);
      player.vel.y = Math.min(player.vel.y, 0);
      tpCooldown = 1.0;   // évite le re-déclenchement / ping-pong
      audio.ui?.();
      break;
    }
  }
}

// Tyroliennes : E près d'une extrémité → s'accroche et glisse vers l'autre bout.
function checkZiplines() {
  if (player.zip) return;
  const zls = env?.ziplines;
  if (!zls || !zls.length || !input.act("use")) return;
  for (const zl of zls) {
    const da = Math.hypot(player.pos.x - zl.a[0], player.pos.z - zl.a[2]);
    const db = Math.hypot(player.pos.x - zl.b[0], player.pos.z - zl.b[2]);
    if (Math.min(da, db) <= (zl.r || 2)) {
      const [from, to] = da <= db ? [zl.a, zl.b] : [zl.b, zl.a];
      player.startZip({ x: from[0], y: from[1] + 2, z: from[2] }, { x: to[0], y: to[1] + 2, z: to[2] }, zl.speed);
      audio.ui?.();
      break;
    }
  }
}

// Par projectile : visuels (tracer, impact) + dégâts UNIQUEMENT en solo.
function onPlayerShoot(origin, dir, weapon) {
  const ray = new THREE.Raycaster(origin, dir, 0.1, weapon.range);
  // Occlusion des dégâts : uniquement les blocs/cover (PAS le sol/terrain).
  const occHits = ray.intersectObjects(env.occluders, false);
  const occDist = occHits.length ? occHits[0].distance : weapon.range;
  // Arrêt visuel de la balle : blocs + sol/terrain.
  const wallHits = ray.intersectObjects(env.solids, false);
  const wallDist = wallHits.length ? wallHits[0].distance : weapon.range;
  let end = origin.clone().addScaledVector(dir, Math.min(wallDist, weapon.range));
  let hitTarget = false;

  if (mode === "solo") {
    match.shots++;
    if (oppAvatar.group.visible && oppAvatar.alive) {
      const tHits = ray.intersectObjects(oppAvatar.hitMeshes, false);
      if (tHits.length && tHits[0].distance < occDist) {
        hitTarget = true;
        const headshot = tHits[0].object.userData.zone === "head";
        const dmg = weapon.damage * (headshot ? (weapon.headshotMult || 1.6) : 1);
        end = tHits[0].point.clone();
        ui.hitmarker(); showDamage(tHits[0].point, dmg, headshot);
        headshot ? audio.headshot() : audio.hit();
        match.hits++; match.damage += dmg;
        const dead = oppAvatar.takeDamage(dmg);
        if (dead) onOpponentKilled(headshot);
      }
    }
  }
  spawnTracer(origin, end, weaponColor(player.weaponState.id));
  if (!hitTarget && wallHits.length && wallHits[0].face) {
    spawnImpact(wallHits[0].point, wallHits[0].face.normal, wallHits[0].object);
  }
}

// Tir du bot vers le joueur.
function onBotShoot(origin, dir, didHit, dmg) {
  const end = origin.clone().addScaledVector(dir, didHit ? origin.distanceTo(player.pos) : 30);
  spawnTracer(origin, end, 0xe8433f);
  if (didHit && player.alive && player.invuln <= 0) {
    audio.hurt();
    ui.flashDamage();
    const dead = player.takeDamage(dmg);
    if (dead) onPlayerKilled();
  }
}

// XP : joueur (débloque armes) + maîtrise de l'arme utilisée (débloque skins).
function grantKillXp(weaponId, headshot) {
  PROFILE.stats.kills++;
  PROFILE.xp += headshot ? 35 : 25;
  const wk = headshot ? 45 : 30;
  PROFILE.weaponXp[weaponId] = (PROFILE.weaponXp[weaponId] || 0) + wk;
  match.weaponXp[weaponId] = (match.weaponXp[weaponId] || 0) + wk;
}

function onOpponentKilled(headshot) {
  score.me++;
  grantKillXp(player.weaponState.id, headshot);
  if (headshot) steam.unlock(ACH.FIRST_HEADSHOT);   // succès : premier headshot (idempotent)
  ui.setScore(score.me, score.opp);
  ui.killfeed(`Tu as éliminé l'adversaire${headshot ? " — HEADSHOT" : ""}`, true);
  if (gameOver()) return;
  if (gm.roundReset && mode === "solo") { resetRound(); return; }
  oppAvatar.setVisible(false);
  if (mode === "solo") botRespawn = gm.respawnDelay;
}

function onPlayerKilled() {
  score.opp++;
  PROFILE.stats.deaths++;
  ui.setScore(score.me, score.opp);
  ui.killfeed("Tu as été éliminé", false);
  player.alive = false;
  if (mode === "online") net.sendDied({});
  if (gameOver()) return;
  if (gm.roundReset && mode === "solo") { resetRound(); return; }
  ui.stateTag("ÉLIMINÉ", "#e8433f");
  myRespawn = gm.respawnDelay;
}

// Vérifie la fin de partie ; renvoie true si la partie est terminée.
function gameOver() {
  if (score.me >= gm.scoreToWin || score.opp >= gm.scoreToWin) {
    endGame(score.me >= gm.scoreToWin);
    return true;
  }
  return false;
}

// Duel par manches : on téléporte les deux aux coins opposés, décompte, puis reprise.
function resetRound() {
  player.spawn(env.spawns[0].clone(), Math.PI / 4);
  player.invuln = gm.roundDelay + 0.4;
  if (mode === "solo" && bot) { bot.spawn(env.spawns[1].clone()); oppAvatar.setVisible(true); }
  roundTimer = gm.roundDelay;
  // synchronise la caméra tout de suite (le joueur est gelé pendant le décompte)
  camera.position.copy(player.pos);
  const d = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  camera.lookAt(player.pos.clone().add(d));
}

function respawnPlayer() {
  const sp = chooseSpawn(oppAvatar.group.position, 0);
  player.spawn(sp, Math.atan2(-sp.x, -sp.z));   // regarde vers le centre
  player.invuln = gm.spawnInvuln;
  ui.clearStateTag();
}

// ============================ BOUCLE ============================
let lastFrameMs = 0, fpsFrames = 0, fpsElapsed = 0;
function loop(nowMs = performance.now()) {
  if (state !== "playing") return;
  requestAnimationFrame(loop);

  // Cap FPS optionnel (0 = illimité, sinon limite via le timestamp rAF).
  if (USER.fpsCap > 0) {
    if (nowMs - lastFrameMs < 1000 / USER.fpsCap - 0.5) return;
    lastFrameMs = nowMs;
  }

  const dt = Math.min(clock.getDelta(), 0.05);

  // Compteur FPS optionnel (rafraîchi ~2×/s).
  if (USER.showFps) {
    fpsFrames++; fpsElapsed += dt;
    if (fpsElapsed >= 0.5) { ui.setFps(Math.round(fpsFrames / fpsElapsed)); fpsFrames = 0; fpsElapsed = 0; }
  }

  if (roundTimer > 0) {
    // --- Décompte de manche : joueur et bot gelés ---
    roundTimer -= dt;
    ui.setScope(false);
    ui.stateTag(roundTimer > 0.05 ? "NOUVELLE MANCHE — " + Math.ceil(roundTimer) : "GO !", "#ff9e2c");
  } else {
    // respawns (modes sans reset de manche)
    if (!player.alive) {
      ui.setScope(false);
      myRespawn -= dt;
      if (myRespawn <= 0) respawnPlayer();
    } else {
      player.update(dt, input, env);
      checkTeleporters(dt);
      checkZiplines();

      // ADS : zoom de la caméra (lunette pour sniper/dmr)
      const ads = input.adsDown && input.locked;
      const id = player.weaponState.id;
      const tgtFov = ads ? (id === "sniper" ? 32 : id === "dmr" ? 50 : USER.fov * 0.72) : USER.fov;
      curFov += (tgtFov - curFov) * Math.min(1, dt * 14);
      camera.fov = curFov; camera.updateProjectionMatrix();

      // Lunette pour le sniper : overlay scope + arme masquée
      const scoped = ads && id === "sniper";
      ui.setScope(scoped);
      viewmodel.group.visible = !scoped;
      viewmodel.update(dt, player, ads);

      // bruit de pas
      const sp = Math.hypot(player.vel.x, player.vel.z);
      if (sp > 1 && player.onGround) {
        stepT -= dt;
        if (stepT <= 0) { audio.step(); stepT = 0.34; }
      }
      if (player.weaponState.reloading && !wasReloading) audio.reload();
      wasReloading = player.weaponState.reloading;
    }

    if (mode === "solo") {
      if (!oppAvatar.alive) {
        botRespawn -= dt;
        if (botRespawn <= 0) { bot.spawn(chooseSpawn(player.pos, 1)); }
      } else {
        bot.update(dt, player.pos, player.alive);
      }
    } else {
      sendNetState(dt);
    }

    // tag d'invincibilité (hors décompte)
    if (player.alive) {
      if (player.invuln > 0) ui.stateTag("PROTÉGÉ", "#ff9e2c"); else ui.clearStateTag();
    }
  }

  // HUD
  ui.setHealth(player.health, player.maxHealth);
  ui.setAmmo(player.weaponState.ammo, player.weapon.mag);
  ui.setWeapon(player.weapon.name);
  ui.setReloading(player.weaponState.reloading);

  // pickups
  if (pickups) {
    pickups.update(dt);
    if (mode === "solo") {
      const gained = pickups.tryCollectSolo(player);
      if (gained > 0) { audio.heal(); ui.killfeed(`+${Math.round(gained)} PV`, true); }
    }
  }

  // tracers
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.08) * 0.9;
    if (t.life <= 0) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); tracers.splice(i, 1); }
  }
  // impacts (fondu sur la fin de vie)
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i];
    im.life -= dt;
    if (im.life < 1) im.mesh.material.opacity = Math.max(0, im.life) * 0.85;
    if (im.life <= 0) { scene.remove(im.mesh); im.mesh.material.dispose(); impacts.splice(i, 1); }
  }

  // objets de carte animés (plateformes, portes, rotations)
  if (env?.animated?.length) { animTime += dt; updateAnimated(env.animated, animTime); }

  // billboards (barres de vie face caméra) — gérés par Sprite automatiquement
  renderer.render(scene, camera);
}

function sendNetState(dt) {
  netAccum += dt;
  if (netAccum < 0.04) return; // ~25 Hz
  netAccum = 0;
  net.sendState({
    x: player.pos.x, y: player.pos.y, z: player.pos.z,
    yaw: player.yaw, classId: player.classId,
    health: player.health, maxHealth: player.maxHealth, alive: player.alive,
  });
}

// ============================ DÉMARRAGE ============================
function startGame(m) {
  mode = m;
  gm = GAMEMODES[PROFILE.mode] || GAMEMODES.duel;
  initRenderer();
  if (!scene || builtMap !== PROFILE.map) buildScene(PROFILE.map);
  score = { me: 0, opp: 0 };
  match = { shots: 0, hits: 0, damage: 0, xpStart: PROFILE.xp, weaponXp: {} };
  roundTimer = 0;
  ui.setScore(0, 0);

  player = new Player(camera, PROFILE.loadout);
  player.onShoot = onPlayerShoot;
  player.onFire = onPlayerFire;
  const spawnIdx = (mode === "online") ? onlineSide : 0;
  player.spawn(env.spawns[spawnIdx].clone(), Math.PI / 4);
  player.invuln = (mode === "online") ? 2.3 : gm.spawnInvuln;
  ui.setClassName(CLASSES[PROFILE.loadout.classId].name);

  curFov = USER.fov;
  camera.fov = USER.fov;
  camera.updateProjectionMatrix();
  audio.init();
  viewmodel.setWeapon(player.weaponState.id, weaponColor(player.weaponState.id));
  wasReloading = false;

  if (mode === "solo") {
    const diff = PROFILE.botDiff || 0.6;
    const botHp = diff < 0.5 ? 70 : diff < 0.75 ? 100 : 130;
    oppAvatar.setClassColor("sniper");
    oppAvatar.setHealthMax(botHp);
    bot = new Bot(oppAvatar, env, diff);
    bot.onShoot = onBotShoot;
    bot.spawn(chooseSpawn(player.pos, 1));

    // Heal pickups en solo : repris directement des pickups de la carte (WYSIWYG,
    // identique au serveur online). Robuste pour les cartes custom (≥ 2 spawns).
    const mapPickups = (env.map?.pickups || [])
      .filter((p) => p && Array.isArray(p.pos))
      .map((p, i) => ({ id: p.id || `heal_${i + 1}`, x: p.pos[0], y: p.pos[1], z: p.pos[2], healAmount: p.healAmount || 35 }));
    pickups?.initLocal(mapPickups);
  } else {
    oppAvatar.setVisible(false);
  }

  state = "playing";
  ui.show(null);
  ui.showHud();
  ui.showFps(USER.showFps);
  ui.clearStateTag();
  clock.getDelta();
  canvas.requestPointerLock();
  loop();
}

function endGame(win) {
  state = "ended";
  ui.setScope(false);
  document.exitPointerLock();
  if (mode === "online") net.disconnect();
  PROFILE.stats.games++;
  if (win) { PROFILE.stats.wins++; PROFILE.xp += 100; }
  saveProfile();

  // --- Succès Steam (no-op silencieux hors Steam / mode web) ---
  if (win) {
    steam.unlock(ACH.FIRST_WIN);
    if (score.opp === 0) steam.unlock(ACH.FLAWLESS);   // manche parfaite : aucun mort
  }
  // Succès cumulatifs (10 victoires, 100 kills, niveau 5) évalués sur les stats du profil.
  steam.evaluateProgress({ stats: PROFILE.stats, level: playerLevel() });

  ui.renderStats();
  ui.endScreen(win, {
    me: score.me, opp: score.opp,
    damage: match.damage, shots: match.shots, hits: match.hits,
    xp: PROFILE.xp - match.xpStart, weaponXp: match.weaponXp,
  });
}

function openPause() {
  if (state !== "playing") return;
  state = "paused";
  ui.el.pause.classList.remove("hidden");
}
function resume() {
  if (state !== "paused") return;
  ui.el.pause.classList.add("hidden");
  document.getElementById("pause-settings").classList.add("hidden");
  state = "playing";
  clock.getDelta();
  canvas.requestPointerLock();
  loop();
}

// ---- Paramètres en jeu (depuis la pause) ----
function applyLiveSettings() {
  if (camera) { camera.fov = USER.fov; camera.updateProjectionMatrix(); }
  audio.setVolume(USER.volume);
  ui.showFps(USER.showFps);
}
function updateSettingsDOM() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const txt = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("set-sens", USER.sensitivity); txt("set-sens-val", Number(USER.sensitivity).toFixed(2));
  set("set-fov", USER.fov); txt("set-fov-val", USER.fov);
  set("set-volume", USER.volume); txt("set-volume-val", Math.round(USER.volume * 100) + "%");
  set("ps-sens", USER.sensitivity); txt("ps-sens-val", Number(USER.sensitivity).toFixed(2));
  set("ps-fov", USER.fov); txt("ps-fov-val", USER.fov);
  set("ps-volume", USER.volume); txt("ps-volume-val", Math.round(USER.volume * 100) + "%");
  const sf = document.getElementById("ps-showfps"); if (sf) sf.checked = USER.showFps;
}
function syncPauseSettings() { updateSettingsDOM(); }

// ---- Remap des touches ----
const KEYBIND_ACTIONS = [
  ["forward", "Avancer"], ["back", "Reculer"], ["left", "Gauche"], ["right", "Droite"],
  ["jump", "Sauter"], ["walk", "Marcher"], ["slide", "Slide"], ["reload", "Recharger"],
  ["weapon1", "Arme 1"], ["weapon2", "Arme 2"], ["use", "Utiliser / Tyrolienne"],
];
function keyLabel(code) {
  if (!code) return "—";
  const map = { Space: "Espace", ControlLeft: "Ctrl", ControlRight: "Ctrl D", AltLeft: "Alt", AltRight: "Alt D",
    ShiftLeft: "Maj", ShiftRight: "Maj D", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  if (map[code]) return map[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}
let _rebinding = null;
function setupKeybinds() {
  renderKeybinds();
  const reset = () => { USER.keybinds = { ...DEFAULT_KEYBINDS }; input.setBinds(USER.keybinds); saveUser(); renderKeybinds(); };
  const rb = document.getElementById("keybinds-reset"); if (rb) rb.onclick = reset;
  const rbp = document.getElementById("keybinds-pause-reset"); if (rbp) rbp.onclick = reset;
  // capture globale d'une touche pendant un remap
  addEventListener("keydown", (e) => {
    if (!_rebinding) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code !== "Escape") {
      USER.keybinds[_rebinding] = e.code;
      input.setBinds(USER.keybinds); saveUser();
    }
    _rebinding = null; renderKeybinds();
  }, true);
}
function renderKeybinds() {
  for (const cid of ["keybinds", "keybinds-pause"]) {
    const c = document.getElementById(cid);
    if (!c) continue;
    c.innerHTML = "";
    for (const [action, label] of KEYBIND_ACTIONS) {
      const row = document.createElement("div");
      row.className = "keybind-row";
      const lab = document.createElement("span"); lab.className = "kb-label"; lab.textContent = label;
      const btn = document.createElement("button"); btn.className = "btn btn-ghost kb-key";
      btn.textContent = _rebinding === action ? "Appuyez…" : keyLabel(USER.keybinds[action]);
      btn.onclick = () => { _rebinding = action; renderKeybinds(); };
      row.appendChild(lab); row.appendChild(btn);
      c.appendChild(row);
    }
  }
}
function setupPauseSettings() {
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.oninput = e.onchange = fn; };
  bind("ps-sens", (e) => { USER.sensitivity = parseFloat(e.target.value); applyLiveSettings(); updateSettingsDOM(); saveUser(); });
  bind("ps-fov", (e) => { USER.fov = parseInt(e.target.value, 10); applyLiveSettings(); updateSettingsDOM(); saveUser(); });
  bind("ps-volume", (e) => { USER.volume = parseFloat(e.target.value); applyLiveSettings(); updateSettingsDOM(); saveUser(); });
  bind("ps-showfps", (e) => { USER.showFps = e.target.checked; applyLiveSettings(); saveUser(); });
  document.getElementById("btn-settings").onclick = () => {
    if (state !== "paused") return;
    ui.el.pause.classList.add("hidden");
    document.getElementById("pause-settings").classList.remove("hidden");
    syncPauseSettings();
    renderKeybinds();
  };
  document.getElementById("btn-settings-back").onclick = () => {
    document.getElementById("pause-settings").classList.add("hidden");
    ui.el.pause.classList.remove("hidden");
  };
}

function backToMenu() {
  ui.el.pause.classList.add("hidden");
  document.getElementById("pause-settings").classList.add("hidden");
  hideMapVote();
  document.exitPointerLock();
  if (net.socket) net.disconnect();
  // Retour à l'éditeur après un test de carte (au lieu du menu).
  if (returnToEditor) {
    returnToEditor = false;
    openEditor();
    return;
  }
  state = "menu";
  ui.show("menu");
}

// ============================ ÉDITEUR ============================
// ===================== MODE DÉVELOPPEUR =====================
// L'éditeur n'est PAS accessible au public. Il n'apparaît que si le mode dev
// est actif : param URL `?dev=1`, flag localStorage `arena_dev`, ou variable
// d'env ARENA_DEV en desktop (Electron). Raccourci secret Ctrl+Shift+E pour
// (dé)basculer le flag à la volée.
function isDevMode() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("dev") === "1") { localStorage.setItem("arena_dev", "1"); }
    if (params.get("dev") === "0") { localStorage.removeItem("arena_dev"); }
  } catch {}
  if (window.arenaDesktop?.isDev) return true; // exposé par le preload Electron
  try { return localStorage.getItem("arena_dev") === "1"; } catch { return false; }
}

function applyDevMode() {
  const dev = isDevMode();
  for (const id of ["btn-editor", "btn-weapons"]) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle("hidden", !dev);
  }
}

function setupDevMode() {
  applyDevMode();
  addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      try {
        const on = localStorage.getItem("arena_dev") === "1";
        if (on) localStorage.removeItem("arena_dev");
        else localStorage.setItem("arena_dev", "1");
      } catch {}
      applyDevMode();
    }
  });
}

function openEditor() {
  if (!isDevMode()) return; // garde-fou : jamais d'éditeur hors mode dev

  state = "editor";
  document.exitPointerLock();
  initRenderer();                    // garantit renderer + caméra
  ui.show(null);                     // masque tous les écrans de menu/HUD
  if (!editor) editor = new Editor(renderer, canvas, { onExit: exitEditor, onTest: startEditorTest });
  editor.open();
}

function exitEditor() {
  if (editor) editor.close();
  if (lastTestId) { unregisterMap(lastTestId); lastTestId = null; }
  state = "menu";
  ui.show("menu");
  refreshMapSelector();              // affiche les éventuelles cartes custom sauvegardées
}

// Lance une partie solo sur la carte en cours d'édition, puis retour éditeur.
function startEditorTest(map) {
  steam.unlock(ACH.EDITOR_TEST);   // succès : tester une carte dans l'éditeur
  if (lastTestId) unregisterMap(lastTestId);
  map.id = "__editor_test_" + Date.now();
  lastTestId = map.id;
  registerMap(map, { listed: false });   // jouable sans polluer le sélecteur du menu
  if (editor) editor.close();
  PROFILE.map = map.id;
  builtMap = null;                        // force la reconstruction de la scène
  returnToEditor = true;
  startGame("solo");
}

function refreshMapSelector() {
  ui.buildPills("map-sel", MAP_LIST, PROFILE.map, (id) => { PROFILE.map = id; saveProfile(); });
}

// ============================ ONLINE ============================
function setupNet() {
  net.on("waiting", () => ui.show("waiting"));
  net.on("mapVote", (d) => showMapVote(d.candidates || [], d.durationMs || 9000));
  net.on("matchFound", async (d) => {
    hideMapVote();
    onlineSide = d.side;
    if (d.mode && GAMEMODES[d.mode]) PROFILE.mode = d.mode;  // mode imposé par le serveur
    const oppClass = d.opponent?.classId || "assault";
    if (d.mapId) { await ensureMap(d.mapId); PROFILE.map = d.mapId; }  // map imposée par le serveur, chargée à la demande
    startGame("online");                 // (re)construit la scène + oppAvatar
    oppAvatar.setVisible(true);
    oppAvatar.setClassColor(oppClass);
    oppAvatar.setHealthMax(CLASSES[oppClass].health);
    ui.chat("Système", "Adversaire trouvé ! Combat !", true);
  });
  net.on("opponentState", (s) => {
    if (!oppAvatar) return;
    oppAvatar.setVisible(s.alive !== false);
    if (s.alive !== false) {
      oppAvatar.setPosition(s.x, s.y, s.z);
      oppAvatar.setYaw(s.yaw);
      oppAvatar.alive = true;
      if (typeof s.health === "number") { oppAvatar.health = s.health; oppAvatar._drawHp(s.health / (s.maxHealth || 100)); }
    } else {
      oppAvatar.alive = false;
    }
  });
  // Mon tir a touché (validé serveur)
  net.on("hit", (d) => {
    ui.hitmarker();
    d.headshot ? audio.headshot() : audio.hit();
    oppAvatar.health = d.oppHealth; oppAvatar._drawHp(d.oppHealth / (oppAvatar.maxHealth || 100));
    showDamage(oppAvatar.group.position.clone().setY(1.4), d.damage, d.headshot);
    match.hits++; match.damage += d.damage;
  });
  // J'ai pris des dégâts (validé serveur)
  net.on("damaged", (d) => {
    player.health = d.health;
    audio.hurt(); ui.flashDamage();
  });
  // J'ai été soigné (validé serveur)
  net.on("healed", (d) => {
    if (typeof d?.health === "number") player.health = d.health;
    audio.heal();
    if (typeof d?.amount === "number" && d.amount > 0) ui.killfeed(`+${Math.round(d.amount)} PV`, true);
  });

  net.on("pickupsInit", (d) => {
    if (!pickups) return;
    pickups.initFromServer(d?.pickups || []);
  });
  net.on("pickupTaken", (d) => {
    if (!pickups) return;
    if (d && d.id) pickups.markTaken(String(d.id), { respawnInMs: d.respawnInMs });
  });
  // Fin de manche (un kill a eu lieu) : score + téléport + décompte
  net.on("roundReset", (d) => {
    const me = d.scores[onlineSide] || 0, opp = d.scores[1 - onlineSide] || 0;
    score = { me, opp };
    ui.setScore(me, opp);
    if (d.killerSide === onlineSide) { ui.killfeed("Tu as éliminé l'adversaire", true); grantKillXp(player.weaponState.id, false); }
    else { ui.killfeed("Tu as été éliminé", false); PROFILE.stats.deaths++; }
    // téléport + invincibilité + décompte
    player.spawn(env.spawns[onlineSide].clone(), Math.PI / 4);
    player.invuln = 2.4;
    roundTimer = 2;
    camera.position.copy(player.pos);
    const dd = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    camera.lookAt(player.pos.clone().add(dd));
  });
  // BLITZ : un kill sans reset — seule la victime réapparaît (event "respawn").
  net.on("kill", (d) => {
    const me = d.scores[onlineSide] || 0, opp = d.scores[1 - onlineSide] || 0;
    score = { me, opp }; ui.setScore(me, opp);
    if (d.killerSide === onlineSide) { ui.killfeed("Tu as éliminé l'adversaire", true); grantKillXp(player.weaponState.id, false); }
    if (d.victimSide === onlineSide) {
      ui.killfeed("Tu as été éliminé", false); PROFILE.stats.deaths++;
      player.alive = false;                       // mort : en attente de réapparition serveur
      ui.stateTag("RÉAPPARITION…", "#ff9e2c");
    }
  });
  net.on("respawn", () => {
    player.spawn(env.spawns[onlineSide].clone(), Math.PI / 4);
    player.alive = true; player.invuln = 1.6;
    ui.clearStateTag();
    camera.position.copy(player.pos);
    const dd = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    camera.lookAt(player.pos.clone().add(dd));
  });
  net.on("gameOver", (d) => {
    const me = d.scores[onlineSide] || 0, opp = d.scores[1 - onlineSide] || 0;
    score = { me, opp };
    endGame(d.winnerSide === onlineSide);
  });
  net.on("opponentLeft", () => {
    ui.chat("Système", "L'adversaire a quitté. Victoire par forfait.", true);
    endGame(true);
  });
  net.on("chat", (d) => ui.chat(d.pseudo, d.text));
  net.on("error", (m) => { ui.chat("Système", m, true); backToMenu(); });
}

// ============================ CHAT ============================
function setupChat() {
  const inp = ui.el.chatInput;
  addEventListener("keydown", (e) => {
    if (state !== "playing") return;
    if (e.code === "Enter") {
      if (inp.classList.contains("hidden")) {
        inp.classList.remove("hidden");
        input.setChatOpen(true);
        document.exitPointerLock();
        inp.focus();
        e.preventDefault();
      } else {
        const text = inp.value.trim();
        if (text) {
          if (mode === "online") net.sendChat(text);
          else ui.chat(PROFILE.pseudo, text);
        }
        inp.value = "";
        inp.classList.add("hidden");
        input.setChatOpen(false);
      }
    } else if (e.code === "Escape" && !inp.classList.contains("hidden")) {
      inp.value = ""; inp.classList.add("hidden"); input.setChatOpen(false);
    }
  });
}

// ============================ UI / BOUTONS ============================
function setupUI() {
  ui.setupTabs();
  ui.buildClassCards(CLASSES, PROFILE.loadout.classId, (id) => {
    PROFILE.loadout.classId = id; saveProfile();
  });
  ui.renderLoadout(() => {});   // grilles d'armes + skins + résumé
  ui.renderStats();

  // Sélecteurs mode + carte
  const modes = Object.entries(GAMEMODES).map(([id, m]) => ({ id, name: m.name, desc: m.desc }));
  ui.buildPills("mode-sel", modes, PROFILE.mode, (id) => { PROFILE.mode = id; saveProfile(); });
  ui.buildPills("map-sel", MAP_LIST, PROFILE.map, (id) => { PROFILE.map = id; saveProfile(); });
  const diffs = [
    { id: "0.4", name: "Facile", desc: "Bot lent, peu précis, 70 PV." },
    { id: "0.6", name: "Normal", desc: "Équilibré, 100 PV." },
    { id: "0.85", name: "Difficile", desc: "Rapide et précis, 130 PV." },
  ];
  ui.buildPills("botdiff-sel", diffs, String(PROFILE.botDiff), (id) => { PROFILE.botDiff = parseFloat(id); saveProfile(); });
  ui.el.pseudo.value = PROFILE.pseudo;
  ui.el.pseudo.oninput = () => { PROFILE.pseudo = ui.el.pseudo.value || "Joueur"; saveProfile(); };

  // Paramètres (sensibilité / FOV) — live + persistance
  const sens = document.getElementById("set-sens");
  const sensVal = document.getElementById("set-sens-val");
  const fov = document.getElementById("set-fov");
  const fovVal = document.getElementById("set-fov-val");
  sens.value = USER.sensitivity; sensVal.textContent = Number(USER.sensitivity).toFixed(2);
  fov.value = USER.fov; fovVal.textContent = USER.fov;
  sens.oninput = () => {
    USER.sensitivity = parseFloat(sens.value);
    sensVal.textContent = USER.sensitivity.toFixed(2);
    saveUser();
  };
  fov.oninput = () => {
    USER.fov = parseInt(fov.value, 10);
    fovVal.textContent = USER.fov;
    if (camera) { camera.fov = USER.fov; camera.updateProjectionMatrix(); }
    saveUser();
  };

  // Qualité graphique : applique le pixelRatio/ombres à chaud, force la reconstruction
  // de la scène (taille de shadow map) au prochain lancement.
  const qualityOpts = Object.entries(QUALITY_PRESETS).map(([id, q]) => ({ id, name: q.label }));
  ui.buildPills("quality-sel", qualityOpts, USER.quality, (id) => {
    USER.quality = id;
    saveUser();
    if (renderer) { initRenderer(); applyRendererQuality(currentQuality()); }
    builtMap = null; // rebâtir la scène (shadowMapSize) au prochain startGame
  });

  // Limite FPS.
  const fpsOpts = [
    { id: "0", name: "Illimité" }, { id: "30", name: "30" }, { id: "60", name: "60" },
    { id: "120", name: "120" }, { id: "144", name: "144" }, { id: "240", name: "240" },
  ];
  ui.buildPills("fpscap-sel", fpsOpts, String(USER.fpsCap), (id) => { USER.fpsCap = parseInt(id, 10); saveUser(); });

  // Compteur FPS.
  const showFps = document.getElementById("set-showfps");
  showFps.checked = USER.showFps;
  showFps.onchange = () => { USER.showFps = showFps.checked; ui.showFps(USER.showFps); saveUser(); };

  // Volume (menu) — appliqué au démarrage et live.
  audio.setVolume(USER.volume);
  const vol = document.getElementById("set-volume");
  const volVal = document.getElementById("set-volume-val");
  vol.value = USER.volume; volVal.textContent = Math.round(USER.volume * 100) + "%";
  vol.oninput = () => {
    USER.volume = parseFloat(vol.value);
    volVal.textContent = Math.round(USER.volume * 100) + "%";
    audio.setVolume(USER.volume);
    syncPauseSettings();
    saveUser();
  };

  // ---- Touches configurables (remap) ----
  input.setBinds(USER.keybinds);
  setupKeybinds();

  // ---- Paramètres accessibles depuis la PAUSE ----
  setupPauseSettings();

  // init audio + petit son sur tous les boutons (1er geste utilisateur)
  document.querySelectorAll(".btn, .tab").forEach((b) =>
    b.addEventListener("click", () => { audio.init(); audio.ui(); }));

  document.getElementById("btn-solo").onclick = () => startGame("solo");
  document.getElementById("btn-editor").onclick = openEditor;
  document.getElementById("btn-weapons").onclick = () => { if (isDevMode()) openWeaponsEditor(); };
  setupDevMode();
  document.getElementById("btn-online").onclick = () => {
    setupNet();
    net.connect();
    setTimeout(() => net.queue(PROFILE.pseudo, PROFILE.loadout.classId, PROFILE.loadout), 200);
  };
  document.getElementById("btn-cancel").onclick = backToMenu;
  document.getElementById("btn-replay").onclick = () => startGame(mode);
  document.getElementById("btn-menu").onclick = backToMenu;
  document.getElementById("btn-resume").onclick = resume;
  document.getElementById("btn-quit").onclick = backToMenu;

  // Pause auto quand on perd le pointer-lock en jeu (touche Échap)
  document.addEventListener("pointerlockchange", () => {
    if (state === "playing" && !document.pointerLockElement &&
        ui.el.chatInput.classList.contains("hidden")) {
      openPause();
    }
  });

  // reverrouiller le pointeur en cliquant pendant le jeu
  canvas.addEventListener("click", () => {
    if (state === "playing" && !input.locked && ui.el.chatInput.classList.contains("hidden")) {
      canvas.requestPointerLock();
    }
  });
}

// Override de queue : envoie carte (legacy) + mode choisi au serveur.
const _origQueue = net.queue.bind(net);
net.queue = (pseudo, classId, loadout) => _origQueue(pseudo, classId, loadout, PROFILE.map, PROFILE.mode);

// ---- Écran de vote de carte (online) ----
let mapVoteTimer = 0;
function showMapVote(candidates, durationMs) {
  const screen = document.getElementById("mapvote");
  const opts = document.getElementById("mapvote-options");
  const timerEl = document.getElementById("mapvote-timer");
  document.getElementById("waiting").classList.add("hidden");
  opts.innerHTML = "";
  let voted = false;
  for (const id of candidates) {
    const name = (MAP_LIST.find((m) => m.id === id)?.name) || id;
    const b = document.createElement("button");
    b.className = "btn btn-secondary";
    b.textContent = name;
    b.onclick = () => {
      if (voted) return; voted = true; net.vote(id);
      b.classList.add("btn-primary");
      timerEl.textContent = "Vote : " + name + " — en attente de l'adversaire…";
      [...opts.children].forEach((c) => { c.disabled = true; });
    };
    opts.appendChild(b);
  }
  screen.classList.remove("hidden");
  let t = Math.ceil(durationMs / 1000);
  clearInterval(mapVoteTimer);
  const tick = () => { if (!voted) timerEl.textContent = `Choisis une carte…  ${Math.max(0, t)}s`; t--; if (t < 0) clearInterval(mapVoteTimer); };
  tick();
  mapVoteTimer = setInterval(tick, 1000);
}
function hideMapVote() {
  clearInterval(mapVoteTimer);
  document.getElementById("mapvote").classList.add("hidden");
}

// Boot : on charge d'abord les données (armes JSON, cartes, profil/réglages persistés)
// AVANT de construire l'UI, car celle-ci en dépend.
// Enregistre les cartes personnalisées (userData en desktop, localStorage en web)
// dans le moteur pour qu'elles soient sélectionnables et jouables (solo).
async function loadCustomMapsIntoEngine() {
  try {
    const list = await listCustomMaps();
    for (const { id } of list) {
      const map = await loadCustomMap(id);
      if (map && map.id) registerMap(map);
    }
  } catch (e) {
    console.error("[main] chargement des cartes custom impossible :", e);
  }
}

async function boot() {
  try {
    // Statut Steam récupéré tôt (no-op/false en web) : conditionne le cloud dans storage.
    await steam.init();
    await Promise.all([loadAllData(), loadMaps()]);
    await loadCustomMapsIntoEngine();
  } catch (e) {
    console.error("[main] échec du chargement initial :", e);
  }
  setupUI();
  setupChat();
  ui.show("menu");
}
boot();
