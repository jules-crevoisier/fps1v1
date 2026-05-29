// Persistance des cartes personnalisées créées dans l'éditeur.
//
// - En Electron : fichiers JSON dans userData/maps/<id>.json via un pont IPC
//   sécurisé (window.arenaDesktop.maps), validé côté process principal
//   (pas d'écriture de chemin arbitraire — voir electron/main.js).
// - Hors Electron (web) : stockées dans localStorage (clé "arena_custom_maps").
//
// Dans les deux cas, l'export/import par fichier .json reste disponible.

const desktop = (typeof window !== "undefined" && window.arenaDesktop && window.arenaDesktop.maps)
  ? window.arenaDesktop.maps : null;

export const canPersistMaps = true;        // toujours vrai (localStorage en secours)
export const isDesktopMaps = !!desktop;

const LS_KEY = "arena_custom_maps";

/** Normalise un nom en identifiant de fichier sûr (a-z, 0-9, _ ). */
export function sanitizeId(name) {
  const base = String(name || "map")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "map";
}

function lsReadAll() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function lsWriteAll(obj) {
  localStorage.setItem(LS_KEY, JSON.stringify(obj));
}

/** Liste les cartes custom : [{ id, name }]. */
export async function listCustomMaps() {
  try {
    if (desktop) {
      const list = await desktop.list();
      return Array.isArray(list) ? list : [];
    }
    const all = lsReadAll();
    return Object.values(all).map((m) => ({ id: m.id, name: m.name || m.id }));
  } catch (e) {
    console.error("[mapStore] liste impossible :", e);
    return [];
  }
}

/** Charge une carte custom par id (ou null). */
export async function loadCustomMap(id) {
  try {
    if (desktop) return await desktop.read(id);
    return lsReadAll()[id] || null;
  } catch (e) {
    console.error("[mapStore] lecture impossible :", e);
    return null;
  }
}

/** Sauvegarde une carte custom (retourne l'id ou null en cas d'échec). */
export async function saveCustomMap(map) {
  if (!map || !map.id) return null;
  try {
    if (desktop) {
      const ok = await desktop.write(map.id, map);
      return ok ? map.id : null;
    }
    const all = lsReadAll();
    all[map.id] = map;
    lsWriteAll(all);
    return map.id;
  } catch (e) {
    console.error("[mapStore] sauvegarde impossible :", e);
    return null;
  }
}

/**
 * Publie une carte dans public/data/maps/ (source de vérité du jeu + serveur),
 * la rendant jouable EN LIGNE après un redémarrage du serveur.
 * Desktop dev uniquement. En web, on retombe sur un export de fichier .json
 * (à déposer manuellement dans public/data/maps/).
 * Retourne "published" | "exported" | null.
 */
export async function publishMapToGame(map) {
  if (!map || !map.id) return null;
  try {
    if (desktop && desktop.publish) {
      const ok = await desktop.publish(map.id, map);
      if (ok) return "published";
    }
    exportMapToFile(map); // secours web : téléchargement du .json
    return "exported";
  } catch (e) {
    console.error("[mapStore] publication impossible :", e);
    return null;
  }
}

/** Supprime une carte custom. */
export async function deleteCustomMap(id) {
  try {
    if (desktop) return await desktop.remove(id);
    const all = lsReadAll();
    delete all[id];
    lsWriteAll(all);
    return true;
  } catch (e) {
    console.error("[mapStore] suppression impossible :", e);
    return false;
  }
}

/** Déclenche le téléchargement d'une carte au format JSON (export). */
export function exportMapToFile(map) {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${map.id || "map"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lit un fichier .json choisi par l'utilisateur et renvoie la carte (Promise). */
export function importMapFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
