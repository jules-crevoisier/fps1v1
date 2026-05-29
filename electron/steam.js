// Intégration Steamworks pour "Arena Duel" (process PRINCIPAL Electron uniquement).
//
// Ce module enveloppe `steamworks.js` (module natif) derrière une API sûre :
// - init() ne lève JAMAIS : si Steam n'est pas lancé, si la lib est absente ou si
//   la plateforme n'est pas supportée, on log un avertissement et on bascule en
//   mode dégradé (available = false). Le jeu reste 100 % jouable sans Steam.
// - Toutes les méthodes (succès, cloud) sont des no-op silencieux quand Steam
//   n'est pas disponible.
//
// IMPORTANT : ne JAMAIS importer ce fichier (ni steamworks.js) dans le renderer.
// L'exposition au renderer se fait exclusivement via IPC (voir main.js + preload.cjs).

import { createRequire } from "module";

// steamworks.js est CommonJS + binaire natif : on le charge via require (pas d'import ESM).
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Configuration : SOURCE UNIQUE de l'AppID.
// 480 = Spacewar, l'AppID de TEST public de Valve (aucun compte Partner requis).
// Pour publier : remplacer par le vrai AppID (ou définir la variable d'env
// STEAM_APP_ID) — c'est le SEUL endroit à modifier.
// ---------------------------------------------------------------------------
export const STEAM_APP_ID = Number(process.env.STEAM_APP_ID) || 480;

// Active des logs détaillés des appels Steam (utile avec l'AppID 480, dont les
// succès ne sont pas déclarés côté backend : on confirme au moins l'appel).
const DEBUG = process.env.STEAM_DEBUG === "1" || STEAM_APP_ID === 480;

const TAG = "[steam]";
function log(...a) { if (DEBUG) console.log(TAG, ...a); }
function warn(...a) { console.warn(TAG, ...a); }

// État interne du module.
const state = {
  available: false,   // true seulement si init a réussi
  client: null,       // API retournée par steamworks.init()
  appId: STEAM_APP_ID,
  playerName: null,
  steamId: null,
  cloudEnabled: false,
  reason: null,       // message d'échec éventuel (diagnostic)
};

/**
 * Initialise Steam de façon sûre. À appeler APRÈS app.whenReady(), avant/au
 * moment de créer la fenêtre. N'échoue jamais (capture toutes les erreurs).
 * @returns {{ available: boolean, appId: number, reason: string|null }}
 */
export function initSteam() {
  if (state.client) return getStatus(); // déjà initialisé (idempotent)

  let steamworks;
  try {
    steamworks = require("steamworks.js");
  } catch (e) {
    state.reason = "module steamworks.js introuvable ou incompatible";
    warn(state.reason, "— le jeu continue sans Steam.", e?.message || e);
    return getStatus();
  }

  try {
    // init() lit steam_appid.txt si présent, sinon utilise l'AppID fourni.
    // On force l'AppID pour garantir la cohérence (source unique de config).
    const client = steamworks.init(STEAM_APP_ID);
    state.client = client;
    state.available = true;

    // Overlay Steam dans Electron (sans planter si indisponible).
    try { steamworks.electronEnableSteamOverlay(); } catch { /* overlay optionnel */ }

    // Infos joueur (best-effort).
    try {
      state.playerName = client.localplayer.getName();
      state.steamId = client.localplayer.getSteamId()?.steamId64?.toString() || null;
    } catch { /* non bloquant */ }

    // Disponibilité du Cloud (compte + app).
    try {
      state.cloudEnabled = !!(client.cloud.isEnabledForAccount() && client.cloud.isEnabledForApp());
    } catch { state.cloudEnabled = false; }

    log(`Steam initialisé (AppID ${STEAM_APP_ID}) — joueur: ${state.playerName || "?"}, cloud: ${state.cloudEnabled}`);
    if (STEAM_APP_ID === 480) {
      log("AppID de TEST 480 : les succès ne sont pas déclarés côté backend Steam,");
      log("ActivateAchievement peut ne rien afficher — comportement attendu en dev.");
    }
  } catch (e) {
    state.available = false;
    state.client = null;
    state.reason = "init Steam échouée (client Steam non lancé ?)";
    warn(state.reason, "— le jeu continue sans Steam.", e?.message || e);
  }

  return getStatus();
}

/** Statut courant (sérialisable, transmis au renderer). */
export function getStatus() {
  return {
    available: state.available,
    appId: state.appId,
    isTestAppId: state.appId === 480,
    playerName: state.playerName,
    steamId: state.steamId,
    cloudEnabled: state.available && state.cloudEnabled,
    reason: state.reason,
  };
}

/**
 * Débloque un succès Steam (idempotent : ne renvoie pas d'erreur si déjà obtenu).
 * No-op si Steam indisponible.
 * @param {string} id - API Name du succès (déclaré dans Steamworks).
 * @returns {{ ok: boolean, alreadyUnlocked?: boolean, reason?: string }}
 */
export function unlockAchievement(id) {
  if (!state.available || !state.client) return { ok: false, reason: "indisponible" };
  if (typeof id !== "string" || !id) return { ok: false, reason: "id invalide" };
  try {
    const ach = state.client.achievement;
    if (ach.isActivated(id)) {
      log(`succès déjà débloqué: ${id}`);
      return { ok: true, alreadyUnlocked: true };
    }
    const ok = ach.activate(id);
    log(`succès débloqué: ${id} -> ${ok}`);
    // Persiste les stats/succès côté Steam (best-effort).
    try { state.client.stats.store(); } catch { /* non bloquant */ }
    return { ok };
  } catch (e) {
    warn("unlockAchievement a échoué pour", id, e?.message || e);
    return { ok: false, reason: e?.message || "erreur" };
  }
}

/** Liste des succès débloqués parmi un set d'ids fournis. */
export function getAchievements(ids) {
  if (!state.available || !state.client || !Array.isArray(ids)) return {};
  const out = {};
  for (const id of ids) {
    try { out[id] = !!state.client.achievement.isActivated(id); }
    catch { out[id] = false; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cloud (Steam Remote Storage)
// ---------------------------------------------------------------------------

/**
 * Lit un fichier du Cloud Steam.
 * @param {string} name
 * @returns {{ ok: boolean, content?: string, exists?: boolean, reason?: string }}
 */
export function cloudRead(name) {
  if (!state.available || !state.client || !state.cloudEnabled) return { ok: false, reason: "cloud indisponible" };
  if (typeof name !== "string" || !name) return { ok: false, reason: "nom invalide" };
  try {
    if (!state.client.cloud.fileExists(name)) return { ok: true, exists: false };
    const content = state.client.cloud.readFile(name);
    return { ok: true, exists: true, content };
  } catch (e) {
    warn("cloudRead a échoué pour", name, e?.message || e);
    return { ok: false, reason: e?.message || "erreur" };
  }
}

/**
 * Écrit un fichier dans le Cloud Steam.
 * @param {string} name
 * @param {string} content
 * @returns {{ ok: boolean, reason?: string }}
 */
export function cloudWrite(name, content) {
  if (!state.available || !state.client || !state.cloudEnabled) return { ok: false, reason: "cloud indisponible" };
  if (typeof name !== "string" || !name || typeof content !== "string") return { ok: false, reason: "arguments invalides" };
  try {
    const ok = state.client.cloud.writeFile(name, content);
    log(`cloudWrite ${name} (${content.length} octets) -> ${ok}`);
    return { ok };
  } catch (e) {
    warn("cloudWrite a échoué pour", name, e?.message || e);
    return { ok: false, reason: e?.message || "erreur" };
  }
}
