// Wrapper Steam côté renderer (client navigateur / Electron).
//
// Il dialogue avec le process principal via le pont sécurisé window.arenaDesktop.steam
// (exposé par preload.cjs). HORS Electron (mode web pur) ou si Steam n'est pas
// disponible, TOUTES les méthodes sont des no-op silencieux : le jeu fonctionne
// exactement pareil. Aucune dépendance au module natif n'existe ici.
//
// Utilisation : import { steam } from "./steam.js"; puis steam.unlock("ACH_FIRST_WIN").

const bridge = (typeof window !== "undefined" && window.arenaDesktop && window.arenaDesktop.steam)
  ? window.arenaDesktop.steam : null;

// IDs des succès (doivent correspondre à public/data/achievements.json ET au backend Steam).
export const ACH = {
  FIRST_WIN: "ACH_FIRST_WIN",
  WIN_10: "ACH_WIN_10",
  KILLS_100: "ACH_KILLS_100",
  FIRST_HEADSHOT: "ACH_FIRST_HEADSHOT",
  LEVEL_5: "ACH_LEVEL_5",
  FLAWLESS: "ACH_FLAWLESS",
  EDITOR_SAVE: "ACH_EDITOR_SAVE",
  EDITOR_TEST: "ACH_EDITOR_TEST",
};

class SteamWrapper {
  constructor() {
    this._status = { available: false, cloudEnabled: false };
    this._ready = null;
    // Mémoïse les succès déjà tentés cette session (anti-spam IPC, idempotence locale).
    this._tried = new Set();
  }

  /** Charge le statut Steam une seule fois (paresseux). */
  async _ensure() {
    if (!bridge) return this._status;
    if (!this._ready) {
      this._ready = bridge.status()
        .then((s) => { this._status = s || this._status; return this._status; })
        .catch(() => this._status);
    }
    return this._ready;
  }

  /** Initialise (récupère le statut). À appeler une fois au boot (optionnel). */
  async init() { return this._ensure(); }

  /** true si Steam est disponible (client lancé + lib OK). false en web. */
  isAvailable() { return !!this._status.available; }

  /** true si le Cloud Steam est utilisable. */
  isCloudEnabled() { return !!(this._status.available && this._status.cloudEnabled); }

  /** Statut complet (lecture synchrone du dernier état connu). */
  getStatus() { return this._status; }

  /**
   * Débloque un succès (idempotent, no-op hors Steam). Ne lève jamais.
   * @param {string} id
   */
  async unlock(id) {
    if (!bridge || !id) return false;
    if (this._tried.has(id)) return true; // déjà tenté cette session
    this._tried.add(id);
    try {
      await this._ensure();
      if (!this._status.available) return false;
      const res = await bridge.unlockAchievement(id);
      return !!(res && res.ok);
    } catch {
      return false; // jamais bloquant
    }
  }

  /**
   * Lit une clé du Cloud Steam. Renvoie la chaîne JSON ou null (absent/indispo).
   * @param {string} name
   * @returns {Promise<string|null>}
   */
  async cloudRead(name) {
    if (!bridge || !name) return null;
    try {
      await this._ensure();
      if (!this.isCloudEnabled()) return null;
      const res = await bridge.cloudRead(name);
      if (res && res.ok && res.exists && typeof res.content === "string") return res.content;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Écrit une clé dans le Cloud Steam (no-op hors cloud). Ne lève jamais.
   * @param {string} name
   * @param {string} content - chaîne JSON
   */
  async cloudWrite(name, content) {
    if (!bridge || !name || typeof content !== "string") return false;
    try {
      await this._ensure();
      if (!this.isCloudEnabled()) return false;
      const res = await bridge.cloudWrite(name, content);
      return !!(res && res.ok);
    } catch {
      return false;
    }
  }

  /**
   * Évalue les succès basés sur des seuils de stats cumulées et débloque ceux atteints.
   * Idempotent (l'unlock se charge de l'anti-spam). À appeler en fin de partie.
   * @param {{ stats: { wins: number, kills: number }, level: number }} p
   */
  async evaluateProgress(p) {
    if (!bridge || !p) return;
    const stats = p.stats || {};
    if ((stats.wins || 0) >= 10) this.unlock(ACH.WIN_10);
    if ((stats.kills || 0) >= 100) this.unlock(ACH.KILLS_100);
    if ((p.level || 1) >= 5) this.unlock(ACH.LEVEL_5);
  }
}

export const steam = new SteamWrapper();
