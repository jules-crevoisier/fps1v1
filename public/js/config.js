// Données de jeu : classes, armes, réglages d'arène.

export const SETTINGS = {
  scoreToWin: 7,        // premier à 7 frags gagne
  respawnDelay: 1.6,    // secondes
  gravity: 22,
  moveSpeed: 6.2,
  sprintMult: 1.55,
  slideBoost: 11,       // vitesse initiale d'un slide
  slideFriction: 7,
  jumpForce: 8.2,
  airControl: 0.35,
  mouseSensitivity: 0.0022,
  playerHeight: 1.7,
  crouchHeight: 0.95,
  arenaSize: 60,
};

// Armes : slot (primary/secondary), dégâts, cadence (tirs/s), chargeur, recharge,
// dispersion, auto/semi, portée. recoil = kick vertical ; recoilH = horizontal ; shake = screenshake.
// pellets = projectiles par tir (shotgun). color = teinte de base du tracer.
// unlock = niveau JOUEUR requis pour débloquer l'arme.
export const WEAPONS = {
  // --- Primaires ---
  rifle:   { name: "Fusil d'assaut", slot: "primary", unlock: 1, damage: 22, fireRate: 9,  mag: 30, reload: 2.0, spread: 0.008, auto: true,  range: 200, color: 0xff9e2c, recoil: 0.013, recoilH: 0.5, shake: 0.05 },
  smg:     { name: "SMG",            slot: "primary", unlock: 1, damage: 14, fireRate: 15, mag: 28, reload: 1.6, spread: 0.016, auto: true,  range: 120, color: 0xffc14d, recoil: 0.008, recoilH: 0.7, shake: 0.035 },
  sniper:  { name: "Sniper",         slot: "primary", unlock: 2, damage: 90, fireRate: 1.1,mag: 5,  reload: 2.8, spread: 0.001, auto: false, range: 400, color: 0xffd27a, headshotMult: 2.0, recoil: 0.08, recoilH: 0.2, shake: 0.2 },
  shotgun: { name: "Fusil à pompe",  slot: "primary", unlock: 3, damage: 11, fireRate: 1.4,mag: 6,  reload: 2.4, spread: 0.05,  auto: false, range: 28,  color: 0xff7b3d, pellets: 9, recoil: 0.05, recoilH: 0.6, shake: 0.16 },
  dmr:     { name: "Tireur d'élite", slot: "primary", unlock: 4, damage: 48, fireRate: 3.5,mag: 12, reload: 2.2, spread: 0.004, auto: false, range: 300, color: 0xffb347, headshotMult: 1.7, recoil: 0.035, recoilH: 0.3, shake: 0.1 },
  lmg:     { name: "Mitrailleuse",   slot: "primary", unlock: 6, damage: 20, fireRate: 11, mag: 60, reload: 3.4, spread: 0.02,  auto: true,  range: 180, color: 0xffa64d, recoil: 0.016, recoilH: 0.8, shake: 0.06 },
  // --- Secondaires ---
  pistol:  { name: "Pistolet",       slot: "secondary", unlock: 1, damage: 28, fireRate: 4,  mag: 12, reload: 1.4, spread: 0.012, auto: false, range: 100, color: 0x9aa0aa, recoil: 0.022, recoilH: 0.4, shake: 0.06 },
  machpist:{ name: "Pistolet-auto",  slot: "secondary", unlock: 2, damage: 13, fireRate: 16, mag: 20, reload: 1.5, spread: 0.03,  auto: true,  range: 70,  color: 0xb0b6c0, recoil: 0.01,  recoilH: 0.9, shake: 0.03 },
  revolver:{ name: "Revolver",       slot: "secondary", unlock: 5, damage: 55, fireRate: 2,  mag: 6,  reload: 1.9, spread: 0.006, auto: false, range: 140, color: 0xc0c6d0, headshotMult: 1.6, recoil: 0.05, recoilH: 0.3, shake: 0.12 },
};

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

// Réglages utilisateur persistés (sensibilité, FOV).
const DEFAULT_USER = { sensitivity: 1.0, fov: 90 };
export const USER = { ...DEFAULT_USER };
try {
  const saved = JSON.parse(localStorage.getItem("arena_settings") || "{}");
  Object.assign(USER, saved);
} catch {}
export function saveUser() {
  try { localStorage.setItem("arena_settings", JSON.stringify(USER)); } catch {}
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
try { Object.assign(PROFILE, JSON.parse(localStorage.getItem("arena_profile") || "{}")); } catch {}
export function saveProfile() {
  try { localStorage.setItem("arena_profile", JSON.stringify(PROFILE)); } catch {}
}
export function levelFromXp(xp) { return Math.floor(Math.sqrt(xp / 100)) + 1; }
export function xpForLevel(lvl) { return (lvl - 1) * (lvl - 1) * 100; }   // xp cumulé requis
export function skinOf(weaponId) { return PROFILE.skins[weaponId] || "default"; }

export function playerLevel() { return levelFromXp(PROFILE.xp); }
export function weaponXpOf(id) { return PROFILE.weaponXp[id] || 0; }
export function weaponLevel(id) { return levelFromXp(weaponXpOf(id)); }
export function weaponUnlocked(id) { return playerLevel() >= (WEAPONS[id].unlock || 1); }
// Un skin se débloque par le NIVEAU DE L'ARME ciblée.
export function skinUnlocked(skinId, weaponId) { return weaponLevel(weaponId) >= (SKINS[skinId].unlock || 1); }
export function weaponColor(weaponId) {
  const s = SKINS[skinOf(weaponId)];
  return (s && s.tint != null) ? s.tint : WEAPONS[weaponId].color;
}
