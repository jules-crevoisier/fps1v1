// Preload Electron : pont IPC sécurisé exposé au renderer.
// CommonJS (.cjs) car les preloads en mode sandbox ne supportent pas l'ESM.
// On n'expose QUE deux méthodes de stockage ; aucun accès Node direct au renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arenaDesktop", {
  isDesktop: true,
  // Mode développeur : piloté par le process principal (voir electron/main.js).
  // Vrai hors build packagé ou si ARENA_DEV est défini ; faux dans le .exe distribué.
  isDev: !!process.env.ARENA_DEV,
  /** Charge un objet persistant ("settings" | "profile"). */
  load: (key) => ipcRenderer.invoke("storage:load", key),
  /** Sauvegarde un objet persistant. */
  save: (key, data) => ipcRenderer.invoke("storage:save", key, data),

  /** Cartes personnalisées (userData/maps) — éditeur intégré. */
  maps: {
    list: () => ipcRenderer.invoke("maps:list"),
    read: (id) => ipcRenderer.invoke("maps:read", id),
    write: (id, data) => ipcRenderer.invoke("maps:write", id, data),
    publish: (id, data) => ipcRenderer.invoke("maps:publish", id, data),
    remove: (id) => ipcRenderer.invoke("maps:remove", id),
  },

  /** Stats d'armes (public/data/weapons.json) — éditeur d'armes. */
  weapons: {
    write: (data) => ipcRenderer.invoke("weapons:write", data),
  },

  /** Couche Steam optionnelle (succès + cloud). Dégradation gracieuse côté main. */
  steam: {
    status: () => ipcRenderer.invoke("steam:status"),
    unlockAchievement: (id) => ipcRenderer.invoke("steam:unlockAchievement", id),
    getAchievements: (ids) => ipcRenderer.invoke("steam:getAchievements", ids),
    cloudRead: (name) => ipcRenderer.invoke("steam:cloudRead", name),
    cloudWrite: (name, content) => ipcRenderer.invoke("steam:cloudWrite", name, content),
  },
});
