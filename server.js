// Arena Duel - serveur Express + Socket.IO
// AUTORITAIRE pour le combat : vie, scores, cadence de tir et résolution des tirs
// sont calculés côté serveur (le client n'inflige plus ses propres dégâts).
// Le déplacement reste rapporté par le client (relayé + interpolé).
import express from "express";
import http from "http";
import os from "os";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

// --- Règles autoritaires (dupliquées du client, source de vérité) ---
const WEAPONS = {
  rifle:   { damage: 22, fireRate: 9,  range: 200 },
  smg:     { damage: 14, fireRate: 15, range: 120 },
  sniper:  { damage: 90, fireRate: 1.1, range: 400, headshotMult: 2.0 },
  shotgun: { damage: 11, fireRate: 1.4, range: 28, pellets: 9 },
  dmr:     { damage: 48, fireRate: 3.5, range: 300, headshotMult: 1.7 },
  lmg:     { damage: 20, fireRate: 11, range: 180 },
  pistol:  { damage: 28, fireRate: 4,  range: 100 },
  machpist:{ damage: 13, fireRate: 16, range: 70 },
  revolver:{ damage: 55, fireRate: 2,  range: 140, headshotMult: 1.6 },
};
const CLASS_HP = { assault: 100, scout: 80, tank: 90 };
const SCORE_TO_WIN = 7;
const ROUND_INVULN_MS = 2300;
const HEAD_Y = 1.62, BODY_Y = 0.95;     // hauteurs de hitbox (monde)
const HEAD_R = 0.32, BODY_R = 0.6;       // rayons angulaires tolérés
const ARENA_LIMIT = 29;                  // demi-taille d'arène (anti out-of-bounds)
const VALID_LOADOUT = (l) => Array.isArray(l) && l.length && l.every((w) => WEAPONS[w]);
const fin = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const VALID_MAP = (m) => m === "arena" || m === "tours";

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
  // Positions simples, communes aux deux clients (carte online synchronisée).
  // (y ~ hauteur caméra : ici on reste aligné sur le sol/plateforme).
  const y = 1.7;
  const idp = (n) => `heal_${mapId}_${n}`;
  if (mapId === "tours") {
    return [
      { id: idp(1), type: "heal", x: 0, y, z: 0, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
      { id: idp(2), type: "heal", x: -9, y, z: 9, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
      { id: idp(3), type: "heal", x: 9, y, z: -9, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
    ];
  }
  // arena (défaut)
  return [
    { id: idp(1), type: "heal", x: 0, y, z: 0, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
    { id: idp(2), type: "heal", x: -10, y, z: -10, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
    { id: idp(3), type: "heal", x: 10, y, z: 10, active: true, healAmount: HEAL_AMOUNT, respawnAtMs: 0 },
  ];
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
    p.y = clamp(s.y, 0, 20);
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

const PORT = Number(process.env.PORT) || 3000;
const exposeOnNetwork = process.argv.includes("--host") || process.env.HOST === "0.0.0.0";
const HOST = exposeOnNetwork ? "0.0.0.0" : "127.0.0.1";

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

server.listen(PORT, HOST, () => {
  console.log("\n  ⚔  Arena Duel");
  console.log(`  ➜  Local:   http://localhost:${PORT}`);
  if (exposeOnNetwork) {
    const network = getNetworkUrls(PORT);
    if (network.length) {
      for (const url of network) console.log(`  ➜  Network: ${url}`);
    } else {
      console.log("  ➜  Network: (aucune interface LAN détectée)");
    }
  }
  console.log();
});
