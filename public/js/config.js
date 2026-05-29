// Données de jeu : classes, armes, réglages d'arène + persistance utilisateur/profil.
// Les ARMES sont chargées depuis public/data/weapons.json (source de vérité unique,
// partagée avec le serveur). USER/PROFILE passent par la couche storage.js
// (fichiers en Electron, localStorage en web), versionnés et validés.

import { loadRaw, saveRaw } from "./storage.js";

// Version du schéma de données persistées (incrémentée lors d'une migration).
export const DATA_VERSION = 1;

export const SETTINGS = {
  scoreToWin: 7,        // premier à 7 frags gagne
  respawnDelay: 1.6,    // secondes
  gravity: 22,
  moveSpeed: 6.2,
  sprintMult: 1.55,
  slideSpeedMult: 1.45, // vitesse de départ du slide = vitesse de sprint × ce facteur (burst COD)
  slideDuration: 0.62,  // durée fixe d'un slide (s) — on ne peut PAS le prolonger
  slideEndSpeedMult: 0.55, // vitesse en fin de slide relative au sprint (puis crouch-walk)
  slideMinSpeedMult: 0.85, // il faut être lancé (≈ sprint) pour déclencher un slide
  slideCooldown: 0.35,  // délai avant de pouvoir re-slider
  slideSteer: 2.5,      // capacité à infléchir la trajectoire pendant le slide (faible)
  jumpForce: 8.2,
  airControl: 0.35,
  mouseSensitivity: 0.0022,
  playerHeight: 1.7,
  crouchHeight: 0.95,
  arenaSize: 60,
};

// ---- Armes : remplies par loadWeapons() depuis data/weapons.json ----
// La référence d'objet reste stable (remplie par mutation) pour les modules
// qui l'importent au chargement.
export const WEAPONS = {};

const hexToInt = (c) => (typeof c === "string" ? parseInt(c.replace("#", ""), 16) : c);

const intToHex = (n) => (typeof n === "number" ? "#" + (n & 0xffffff).toString(16).padStart(6, "0") : n);

/**
 * Applique un objet de données d'armes (format weapons.json) dans WEAPONS,
 * en place (référence stable). Utilisé au boot et par l'éditeur d'armes (live).
 * @param {{ weapons?: Record<string, object> }} json
 * @returns {boolean} true si appliqué
 */
export function applyWeaponsData(json) {
  const defs = json && json.weapons;
  if (!defs || typeof defs !== "object") return false;
  for (const id of Object.keys(WEAPONS)) delete WEAPONS[id];
  for (const [id, def] of Object.entries(defs)) {
    WEAPONS[id] = { ...def, color: hexToInt(def.color) };
  }
  return true;
}

/**
 * Sérialise WEAPONS au format weapons.json (couleurs en chaînes #rrggbb).
 * @returns {{ version: number, weapons: Record<string, object> }}
 */
export function serializeWeapons() {
  const weapons = {};
  for (const [id, w] of Object.entries(WEAPONS)) {
    weapons[id] = { ...w, color: intToHex(w.color) };
  }
  return { version: 1, weapons };
}

async function loadWeapons() {
  try {
    const res = await fetch("data/weapons.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!applyWeaponsData(json)) throw new Error("format weapons.json invalide");
  } catch (e) {
    console.error("[config] chargement des armes impossible :", e);
  }
}

// Skins cosmétiques universels (teinte du tracer + viewmodel). unlock = niveau requis.
export const SKINS = {
  default: { name: "Standard", tint: null,     rarity: "common",    unlock: 1 },
  amber:   { name: "Ambre",    tint: 0xff9e2c, rarity: "common",    unlock: 1 },
  crimson: { name: "Cramoisi", tint: 0xe8433f, rarity: "rare",      unlock: 2 },
  toxic:   { name: "Toxique",  tint: 0x9be83f, rarity: "rare",      unlock: 3 },
  ice:     { name: "Glace",    tint: 0x4fc3ff, rarity: "epic",      unlock: 5 },
  void:    { name: "Néant",    tint: 0xb14bff, rarity: "epic",      unlock: 7 },
  gold:    { name: "Or",       tint: 0xffd24a, rarity: "legendary", unlock: 10 },
};

// ---- Presets de qualité graphique (pilote le rendu, voir main.js) ----
export const QUALITY_PRESETS = {
  low:    { label: "Bas",   pixelRatio: 1,   shadows: false, shadowMapSize: 1024, antialias: false },
  medium: { label: "Moyen", pixelRatio: 1.5, shadows: true,  shadowMapSize: 1024, antialias: true },
  high:   { label: "Élevé", pixelRatio: 2,   shadows: true,  shadowMapSize: 2048, antialias: true },
};
const FPS_CAPS = [0, 30, 60, 120, 144, 240];

// ---- Réglages utilisateur persistés ----
const DEFAULT_USER = { version: DATA_VERSION, sensitivity: 1.0, fov: 90, quality: "high", fpsCap: 0, showFps: false };
export const USER = { ...DEFAULT_USER };

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v, def) => (isFiniteNum(v) ? v : def);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyUser(saved) {
  const o = saved && typeof saved === "object" ? saved : {};
  USER.sensitivity = clamp(num(o.sensitivity, DEFAULT_USER.sensitivity), 0.2, 3);
  USER.fov = clamp(Math.round(num(o.fov, DEFAULT_USER.fov)), 70, 110);
  USER.quality = QUALITY_PRESETS[o.quality] ? o.quality : DEFAULT_USER.quality;
  USER.fpsCap = FPS_CAPS.includes(o.fpsCap) ? o.fpsCap : DEFAULT_USER.fpsCap;
  USER.showFps = typeof o.showFps === "boolean" ? o.showFps : DEFAULT_USER.showFps;
  USER.version = DATA_VERSION;
}

export function saveUser() {
  USER.version = DATA_VERSION;
  saveRaw("settings", USER);
}

// Classes : 2 armes + modificateurs
// Icônes vectorielles au trait (héritent de currentColor).
const SVG = {
  assault: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`,
  scout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M13 2 5 13h5l-1 9 9-12h-5l1-8z"/></svg>`,
  sniper: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="1" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="1" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="23" y2="12"/></svg>`,
};

// Classes = archétypes (vie / vitesse). Les armes viennent désormais du LOADOUT.
export const CLASSES = {
  assault: { name: "Assaut", iconSvg: SVG.assault, desc: "Équilibré. Vie solide, vitesse standard.", health: 100, speedMult: 1.0 },
  scout:   { name: "Scout",  iconSvg: SVG.scout,  desc: "Rapide et glissant. Moins de vie.",        health: 80,  speedMult: 1.18 },
  tank:    { name: "Sniper", iconSvg: SVG.sniper, desc: "Mortel à distance. Un peu plus lent.",     health: 90,  speedMult: 0.92 },
};

// Couleur d'affichage par rareté de skin.
export const RARITY_COLORS = { common: "#9aa0aa", rare: "#4fc3ff", epic: "#b14bff", legendary: "#ffd24a" };

// Modes de jeu.
export const GAMEMODES = {
  duel:  { name: "Duel", desc: "1v1 par manches : à chaque élimination, reset et nouveau round. Premier à 7.", scoreToWin: 7, respawnDelay: 1.6, spawnInvuln: 0, multiSpawn: false, roundReset: true, roundDelay: 2 },
  blitz: { name: "Blitz", desc: "Respawn rapide, invincibilité courte au spawn, points de spawn multiples. Premier à 12.", scoreToWin: 12, respawnDelay: 0.8, spawnInvuln: 1.5, multiSpawn: true },
};

// ---- Profil joueur persistant (loadout, skins, stats, progression) ----
const DEFAULT_PROFILE = {
  version: DATA_VERSION,
  pseudo: "Joueur" + Math.floor(Math.random() * 1000),
  loadout: { classId: "assault", primary: "rifle", secondary: "pistol" },
  mode: "duel",
  map: "arena",
  botDiff: 0.6,         // difficulté du bot (0.4 / 0.6 / 0.85)
  skins: {},            // weaponId -> skinId
  weaponXp: {},         // weaponId -> xp (débloque les skins de cette arme)
  stats: { games: 0, wins: 0, kills: 0, deaths: 0 },
  xp: 0,                // xp joueur (débloque les armes)
};
export const PROFILE = JSON.parse(JSON.stringify(DEFAULT_PROFILE));

function applyProfile(saved) {
  const o = saved && typeof saved === "object" ? saved : {};
  if (typeof o.pseudo === "string" && o.pseudo.trim()) PROFILE.pseudo = o.pseudo.slice(0, 16);
  if (o.loadout && typeof o.loadout === "object") {
    if (CLASSES[o.loadout.classId]) PROFILE.loadout.classId = o.loadout.classId;
    if (WEAPONS[o.loadout.primary]) PROFILE.loadout.primary = o.loadout.primary;
    if (WEAPONS[o.loadout.secondary]) PROFILE.loadout.secondary = o.loadout.secondary;
  }
  if (GAMEMODES[o.mode]) PROFILE.mode = o.mode;
  if (typeof o.map === "string") PROFILE.map = o.map;
  if (isFiniteNum(o.botDiff)) PROFILE.botDiff = o.botDiff;
  if (o.skins && typeof o.skins === "object") PROFILE.skins = { ...o.skins };
  if (o.weaponXp && typeof o.weaponXp === "object") PROFILE.weaponXp = { ...o.weaponXp };
  if (o.stats && typeof o.stats === "object") {
    PROFILE.stats = {
      games: Math.max(0, num(o.stats.games, 0)),
      wins: Math.max(0, num(o.stats.wins, 0)),
      kills: Math.max(0, num(o.stats.kills, 0)),
      deaths: Math.max(0, num(o.stats.deaths, 0)),
    };
  }
  if (isFiniteNum(o.xp)) PROFILE.xp = Math.max(0, o.xp);
  PROFILE.version = DATA_VERSION;
}

export function saveProfile() {
  PROFILE.version = DATA_VERSION;
  saveRaw("profile", PROFILE);
}

/**
 * Charge toutes les données nécessaires avant le démarrage de l'UI :
 * armes (JSON), réglages et profil (storage). À appeler une fois au boot.
 */
export async function loadAllData() {
  await loadWeapons();
  const [savedUser, savedProfile] = await Promise.all([loadRaw("settings"), loadRaw("profile")]);
  applyUser(savedUser);
  applyProfile(savedProfile);
}

export function levelFromXp(xp) { return Math.floor(Math.sqrt(xp / 100)) + 1; }
export function xpForLevel(lvl) { return (lvl - 1) * (lvl - 1) * 100; }   // xp cumulé requis
export function skinOf(weaponId) { return PROFILE.skins[weaponId] || "default"; }

export function playerLevel() { return levelFromXp(PROFILE.xp); }
export function weaponXpOf(id) { return PROFILE.weaponXp[id] || 0; }
export function weaponLevel(id) { return levelFromXp(weaponXpOf(id)); }
export function weaponUnlocked(id) { return playerLevel() >= (WEAPONS[id]?.unlock || 1); }
// Un skin se débloque par le NIVEAU DE L'ARME ciblée.
export function skinUnlocked(skinId, weaponId) { return weaponLevel(weaponId) >= (SKINS[skinId].unlock || 1); }
export function weaponColor(weaponId) {
  const s = SKINS[skinOf(weaponId)];
  return (s && s.tint != null) ? s.tint : WEAPONS[weaponId]?.color;
}
