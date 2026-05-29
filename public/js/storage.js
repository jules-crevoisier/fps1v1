// Couche d'abstraction de persistance des données.
// - En Electron : écrit/lit des fichiers JSON dans le dossier userData via un pont
//   IPC sécurisé (window.arenaDesktop, exposé par preload.cjs — pas de nodeIntegration).
// - Hors Electron (web/dev) : retombe proprement sur localStorage.
// - Steam Cloud (optionnel) : si disponible, la sauvegarde est AUSSI poussée vers le
//   Steam Remote Storage et, au chargement, on prend la version la plus récente
//   (résolution de conflit « dernier écrit gagne » via un timestamp `_ts`).
// L'API est asynchrone côté lecture pour rester compatible avec les deux backends.

import { steam } from "./steam.js";

const LS_KEYS = { settings: "arena_settings", profile: "arena_profile" };

const desktop = (typeof window !== "undefined" && window.arenaDesktop) ? window.arenaDesktop : null;

/** true si l'application tourne dans le wrapper desktop Electron. */
export const isDesktop = !!desktop;

function parseMaybe(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw; // déjà désérialisé (IPC)
  try {
    return JSON.parse(raw);
  } catch {
    return null; // données corrompues : on ignore au lieu de planter
  }
}

/** Timestamp d'une sauvegarde (champ `_ts`), 0 si absent (sauvegardes héritées). */
function tsOf(obj) {
  return (obj && typeof obj === "object" && Number.isFinite(obj._ts)) ? obj._ts : 0;
}

/** Lit la version LOCALE (fichier Electron ou localStorage). */
async function loadLocal(key) {
  if (desktop) return parseMaybe(await desktop.load(key));
  return parseMaybe(localStorage.getItem(LS_KEYS[key] || key));
}

/**
 * Charge les données brutes associées à une clé logique ("settings" | "profile").
 * Si le Steam Cloud est disponible, on compare local vs cloud et on renvoie la
 * version la plus récente (dernier écrit gagne).
 * @param {string} key
 * @returns {Promise<unknown|null>} L'objet désérialisé ou null si absent/corrompu.
 */
export async function loadRaw(key) {
  try {
    const local = await loadLocal(key);

    // Steam Cloud : si plus récent que le local, on l'utilise (et on resynchronise le local).
    if (steam.isCloudEnabled()) {
      const cloud = parseMaybe(await steam.cloudRead(key));
      if (cloud && tsOf(cloud) > tsOf(local)) {
        // Réaligne le local sur la version cloud (sans repousser au cloud : déjà à jour).
        if (desktop) desktop.save(key, cloud);
        else { try { localStorage.setItem(LS_KEYS[key] || key, JSON.stringify(cloud)); } catch { /* quota */ } }
        return cloud;
      }
    }
    return local;
  } catch (e) {
    console.error("[storage] échec de chargement", key, e);
    return null;
  }
}

const writeTimers = {};

/**
 * Persiste des données (fire-and-forget, debouncé pour limiter les écritures disque).
 * Écrit TOUJOURS en local, et pousse en parallèle vers le Steam Cloud si disponible.
 * Un timestamp `_ts` est ajouté pour la résolution de conflit cloud.
 * @param {string} key
 * @param {unknown} data
 */
export function saveRaw(key, data) {
  clearTimeout(writeTimers[key]);
  writeTimers[key] = setTimeout(() => {
    try {
      // Enveloppe horodatée (clone : on ne mute pas l'objet vivant USER/PROFILE).
      const payload = (data && typeof data === "object") ? { ...data, _ts: Date.now() } : data;

      if (desktop) desktop.save(key, payload);
      else localStorage.setItem(LS_KEYS[key] || key, JSON.stringify(payload));

      // Push cloud (best-effort, jamais bloquant pour le jeu).
      if (steam.isCloudEnabled()) {
        steam.cloudWrite(key, JSON.stringify(payload)).catch(() => {});
      }
    } catch (e) {
      console.error("[storage] échec de sauvegarde", key, e);
    }
  }, 120);
}
