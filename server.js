// Arena Duel - serveur Express + Socket.IO
// AUTORITAIRE pour le combat : vie, scores, cadence de tir et résolution des tirs
// sont calculés côté serveur (le client n'inflige plus ses propres dégâts).
// Le déplacement reste rapporté par le client (relayé + interpolé).
import express from "express";
import http from "http";
import os from "os";
import fs from "fs";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

// --- Source de vérité PARTAGÉE client/serveur : données JSON ---
// Le serveur lit les mêmes fichiers que le client pour éviter toute divergence
// des stats d'armes ou des positions de pickups.
function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), "utf8"));
}

// Armes : on ne garde côté serveur que ce qui sert à la résolution autoritaire.
const WEAPONS = {};
try {
  const weaponsData = readJson("public/data/weapons.json");
  for (const [id, w] of Object.entries(weaponsData.weapons || {})) {
    WEAPONS[id] = { damage: w.damage, fireRate: w.fireRate, range: w.range };
    if (w.headshotMult != null) WEAPONS[id].headshotMult = w.headshotMult;
    if (w.pellets != null) WEAPONS[id].pellets = w.pellets;
  }
} catch (e) {
  console.error("[server] Impossible de charger public/data/weapons.json :", e.message);
}

// Cartes : chargées dynamiquement depuis public/data/maps/ (toute carte publiée
// par l'éditeur devient jouable en ligne après un redémarrage du serveur).
const MAP_DATA = {};
function loadMapsFromDisk() {
  for (const k of Object.keys(MAP_DATA)) delete MAP_DATA[k];
  const dir = path.join(__dirname, "public/data/maps");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); }
  catch (e) { console.error("[server] Lecture du dossier des cartes impossible :", e.message); }
  for (const f of files) {
    try {
      const m = readJson(`public/data/maps/${f}`);
      const id = m.id || f.replace(/\.json$/, "");
      if (/^[a-z0-9_]+$/.test(id)) MAP_DATA[id] = m;
      else console.error(`[server] Carte ignorée (id invalide) : ${f}`);
    } catch (e) {
      console.error(`[server] Impossible de charger la carte ${f} :`, e.message);
    }
  }
  console.log(`[server] Cartes chargées : ${Object.keys(MAP_DATA).join(", ") || "(aucune)"}`);
}
loadMapsFromDisk();

const CLASS_HP = { assault: 100, scout: 80, tank: 90 };
const SCORE_TO_WIN = 7;
const ROUND_INVULN_MS = 2300;
const HEAD_Y = 1.62, BODY_Y = 0.95;     // hauteurs de hitbox (monde)
const HEAD_R = 0.32, BODY_R = 0.6;       // rayons angulaires tolérés
const ARENA_LIMIT = 29;                  // demi-taille d'arène (anti out-of-bounds)
const VALID_LOADOUT = (l) => Array.isArray(l) && l.length && l.every((w) => WEAPONS[w]);
const fin = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const VALID_MAP = (m) => Object.prototype.hasOwnProperty.call(MAP_DATA, m);

const HEAL_AMOUNT = 35;
const HEAL_RESPAWN_MS = 10_000;
const HEAL_RADIUS = 1.0; // rayon de ramassage (monde)

let waiting = null;
const rooms = new Map();

function makeRoomId() { return "r" + Math.random().toString(36).slice(2, 8); }

function newPlayer(id, side, pseudo, classId, loadout) {
  const maxHealth = CLASS_HP[classId] || 100;
  const lo = VALID_LOADOUT(loadout) ? loadout : ["rifle", "pistol"];
  return { id, side, pseudo, classId, loadout: lo, x: 0, y: 1.7, z: 0, yaw: 0,
           health: maxHealth, maxHealth, alive: true, lastShot: 0,
           invulnUntil: Date.now() + ROUND_INVULN_MS };
}

function makeHealPickupsForMap(mapId) {
  // Positions lues depuis la carte JSON (source unique partagée avec le client/éditeur).
  const map = MAP_DATA[mapId] || MAP_DATA.arena;
  const list = (map && Array.isArray(map.pickups)) ? map.pickups : [];
  return list.map((p, i) => ({
    id: p.id || `heal_${mapId}_${i + 1}`,
    type: p.type || "heal",
    x: p.pos[0], y: p.pos[1], z: p.pos[2],
    active: true,
    healAmount: p.healAmount || HEAL_AMOUNT,
    respawnAtMs: 0,
  }));
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function tryCollectHeal(room, player) {
  if (!player.alive) return;
  if (player.health >= player.maxHealth) return;
  const now = Date.now();
  const pr = { x: player.x, y: player.y, z: player.z };
  for (const p of room.pickups) {
    if (!p.active) {
      if (p.respawnAtMs > 0 && now >= p.respawnAtMs) {
        p.active = true;
        p.respawnAtMs = 0;
        io.to(room.ids[0]).emit("pickupTaken", { id: p.id, respawnInMs: 0 }); // "respawn" = visible
        io.to(room.ids[1]).emit("pickupTaken", { id: p.id, respawnInMs: 0 });
      }
      continue;
    }
    if (dist2(pr, p) <= HEAL_RADIUS * HEAL_RADIUS) {
      const before = player.health;
      player.health = Math.min(player.maxHealth, player.health + (p.healAmount || HEAL_AMOUNT));
      const gained = player.health - before;
      if (gained <= 0) return;
      p.active = false;
      p.respawnAtMs = now + HEAL_RESPAWN_MS;
      io.to(player.id).emit("healed", { health: player.health, amount: gained });
      // informer l'adversaire (barre de vie correcte) + retirer le pickup chez les deux clients
      io.to(room.ids[0]).emit("pickupTaken", { id: p.id, respawnInMs: HEAL_RESPAWN_MS });
      io.to(room.ids[1]).emit("pickupTaken", { id: p.id, respawnInMs: HEAL_RESPAWN_MS });
      return;
    }
  }
}

// Angle (rad) entre la visée et la direction vers un point cible.
function aimAngleTo(p, dir, tx, ty, tz) {
  const vx = tx - p.x, vy = ty - p.y, vz = tz - p.z;
  const vl = Math.hypot(vx, vy, vz) || 1e-6;
  const dot = (dir.x * vx + dir.y * vy + dir.z * vz) / vl;
  return { ang: Math.acos(Math.max(-1, Math.min(1, dot))), dist: vl };
}

function resolveShot(room, shooter, target, msg) {
  if (!msg || typeof msg !== "object" || !msg.dir) return;
  const w = WEAPONS[msg.weaponId];
  if (!w) return;
  if (!shooter.loadout.includes(msg.weaponId)) return;   // anti arme non équipée/verrouillée
  if (![msg.ox, msg.oy, msg.oz, msg.dir.x, msg.dir.y, msg.dir.z].every(fin)) return;
  const now = Date.now();
  // anti fire-rate hack (30% de tolérance)
  if (now - shooter.lastShot < (1000 / w.fireRate) * 0.7) return;
  shooter.lastShot = now;
  if (!target.alive || now < target.invulnUntil || !shooter.alive) return;

  const dir = msg.dir;
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1e-6;
  const d = { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl };
  const o = { x: msg.ox, y: msg.oy, z: msg.oz };

  const body = aimAngleTo(o, d, target.x, target.y - 1.7 + BODY_Y, target.z);
  const head = aimAngleTo(o, d, target.x, target.y - 1.7 + HEAD_Y, target.z);
  if (body.dist > w.range) return;

  const headTol = Math.atan2(HEAD_R, head.dist);
  const bodyTol = Math.atan2(BODY_R, body.dist);
  let headshot = false, hit = false;
  if (head.ang <= headTol) { hit = true; headshot = true; }
  else if (body.ang <= bodyTol) { hit = true; }
  if (!hit) return;

  let dmg = w.damage * (w.pellets || 1);
  if (w.range <= 30) dmg *= Math.max(0.25, 1 - body.dist / w.range); // falloff pompe
  if (headshot) dmg *= (w.headshotMult || 1.6);
  dmg = Math.round(dmg);

  target.health -= dmg;
  if (target.health <= 0) {
    target.health = 0; target.alive = false;
    onKill(room, shooter, target);
  } else {
    io.to(shooter.id).emit("hit", { oppHealth: target.health, headshot, damage: dmg });
    io.to(target.id).emit("damaged", { health: target.health, damage: dmg });
  }
}

function onKill(room, killer, victim) {
  room.scores[killer.id] = (room.scores[killer.id] || 0) + 1;
  const scores = { [killer.side]: room.scores[killer.id], [victim.side]: room.scores[victim.id] || 0 };

  if (room.scores[killer.id] >= SCORE_TO_WIN) {
    io.to(room.ids[0]).emit("gameOver", { winnerSide: killer.side, scores });
    io.to(room.ids[1]).emit("gameOver", { winnerSide: killer.side, scores });
    rooms.delete(room.id);
    return;
  }
  // reset de manche : pleine vie + invincibilité, chacun à son spawn (= son side)
  const until = Date.now() + ROUND_INVULN_MS;
  for (const id of room.ids) {
    const p = room.players[id];
    p.health = p.maxHealth; p.alive = true; p.invulnUntil = until;
  }
  io.to(room.ids[0]).emit("roundReset", { killerSide: killer.side, scores });
  io.to(room.ids[1]).emit("roundReset", { killerSide: killer.side, scores });
}

io.on("connection", (socket) => {
  socket.on("queue", (data) => {
    socket.data.pseudo = String((data && data.pseudo) || "Joueur").slice(0, 16);
    socket.data.classId = (data && data.classId) || "assault";
    socket.data.loadout = (data && data.loadout) ? [data.loadout.primary, data.loadout.secondary] : null;
    socket.data.mapId = VALID_MAP(data && data.mapId) ? data.mapId : "arena";

    if (waiting && waiting.id !== socket.id && waiting.connected) {
      const a = waiting; waiting = null;
      const roomId = makeRoomId();
      a.join(roomId); socket.join(roomId);
      a.data.roomId = roomId; socket.data.roomId = roomId;
      a.data.oppId = socket.id; socket.data.oppId = a.id;
      const mapId = VALID_MAP(a.data.mapId) ? a.data.mapId : (VALID_MAP(socket.data.mapId) ? socket.data.mapId : "arena");

      const room = {
        id: roomId, ids: [a.id, socket.id],
        mapId,
        players: {
          [a.id]: newPlayer(a.id, 0, a.data.pseudo, a.data.classId, a.data.loadout),
          [socket.id]: newPlayer(socket.id, 1, socket.data.pseudo, socket.data.classId, socket.data.loadout),
        },
        scores: { [a.id]: 0, [socket.id]: 0 },
        pickups: makeHealPickupsForMap(mapId),
      };
      rooms.set(roomId, room);

      a.emit("matchFound", { roomId, side: 0, mapId, opponent: { pseudo: socket.data.pseudo, classId: socket.data.classId } });
      socket.emit("matchFound", { roomId, side: 1, mapId, opponent: { pseudo: a.data.pseudo, classId: a.data.classId } });

      // Initialisation des pickups (état complet) côté clients
      io.to(a.id).emit("pickupsInit", { pickups: room.pickups });
      io.to(socket.id).emit("pickupsInit", { pickups: room.pickups });
    } else {
      waiting = socket;
      socket.emit("waiting");
    }
  });

  socket.on("state", (s) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !s || ![s.x, s.y, s.z, s.yaw].every(fin)) return;
    const p = room.players[socket.id];
    if (!p) return;
    // clamp anti out-of-bounds / téléport hors arène
    p.x = clamp(s.x, -ARENA_LIMIT, ARENA_LIMIT);
    p.z = clamp(s.z, -ARENA_LIMIT, ARENA_LIMIT);
    p.y = clamp(s.y, -20, 40); // marge pour reliefs (vallées) + sauts
    p.yaw = s.yaw;

    // Heal pickups : collecte autoritaire (serveur)
    tryCollectHeal(room, p);

    socket.to(socket.data.roomId).emit("opponentState", {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      health: p.health, maxHealth: p.maxHealth, alive: p.alive,
    });
  });

  socket.on("shot", (msg) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const shooter = room.players[socket.id];
    const target = room.players[socket.data.oppId];
    if (shooter && target) resolveShot(room, shooter, target, msg);
  });

  socket.on("chat", (m) => {
    const rid = socket.data.roomId;
    if (rid) io.to(rid).emit("chat", { pseudo: socket.data.pseudo, text: String(m || "").slice(0, 200) });
  });

  socket.on("disconnect", () => {
    if (waiting && waiting.id === socket.id) waiting = null;
    const rid = socket.data.roomId;
    if (rid) { socket.to(rid).emit("opponentLeft"); rooms.delete(rid); }
  });
});

// Stabilité : un message malformé ne doit jamais faire tomber le serveur.
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

function getNetworkUrls(port) {
  const urls = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const net of iface) {
      const isIPv4 = net.family === "IPv4" || net.family === 4;
      if (isIPv4 && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

/**
 * Démarre le serveur HTTP + Socket.IO.
 * Utilisé directement (`node server.js`) ET importé par le process Electron.
 *
 * @param {{ port?: number, host?: string, exposeOnNetwork?: boolean }} [options]
 * @returns {import("http").Server} L'instance serveur (pour un arrêt propre).
 */
export function startServer(options = {}) {
  const port = options.port ?? (Number(process.env.PORT) || 3000);
  const exposeOnNetwork = options.exposeOnNetwork ??
    (process.argv.includes("--host") || process.env.HOST === "0.0.0.0");
  const host = options.host ?? (exposeOnNetwork ? "0.0.0.0" : "127.0.0.1");

  server.listen(port, host, () => {
    console.log("\n  ⚔  Arena Duel");
    console.log(`  ➜  Local:   http://localhost:${port}`);
    if (exposeOnNetwork) {
      const network = getNetworkUrls(port);
      if (network.length) {
        for (const url of network) console.log(`  ➜  Network: ${url}`);
      } else {
        console.log("  ➜  Network: (aucune interface LAN détectée)");
      }
    }
    console.log();
  });
  return server;
}

// Auto-démarrage uniquement si lancé directement (et non importé par Electron).
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
