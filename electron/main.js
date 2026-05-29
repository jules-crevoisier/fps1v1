// Process principal Electron pour "Arena Duel" (wrapper desktop).
//
// Approche retenue (la plus simple et robuste) : le serveur Express/Socket.IO
// existant est démarré EN INTERNE dans ce process via startServer() (import direct,
// pas de child process à superviser), puis la fenêtre charge http://localhost:PORT.
// L'arrêt du serveur est géré à la fermeture de la dernière fenêtre.
//
// Sécurité : contextIsolation activé, nodeIntegration désactivé, sandbox activé.
// La persistance fichier passe par IPC (handlers storage:* ci-dessous) + preload.

import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { startServer } from "../server.js";
import {
  initSteam, getStatus as steamStatus, unlockAchievement, getAchievements,
  cloudRead, cloudWrite,
} from "./steam.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// URL du serveur de jeu. Par défaut : serveur en ligne (Render) → l'app desktop
// joue le multijoueur réel et lit les cartes/armes publiées. Surchargeable via
// ARENA_SERVER_URL (ex. http://localhost:3000 pour un serveur local embarqué).
const SERVER_URL = process.env.ARENA_SERVER_URL || "https://fps1v1.onrender.com";
const USE_EMBEDDED = /localhost|127\.0\.0\.1/.test(SERVER_URL);

// Mode développeur : actif hors build packagé (npm run app:dev) ou si ARENA_DEV
// est forcé. Propagé au renderer via preload (process.env.ARENA_DEV).
if (!app.isPackaged) process.env.ARENA_DEV = process.env.ARENA_DEV || "1";

let serverInstance = null;
let mainWindow = null;

// --- Persistance fichier (userData/saves/<clé>.json) via IPC ---
const ALLOWED_KEYS = new Set(["settings", "profile"]);
function savesDir() { return path.join(app.getPath("userData"), "saves"); }
function fileFor(key) { return path.join(savesDir(), `${key}.json`); }

// Dossier des cartes personnalisées (userData/maps) — restreint, pas de chemin arbitraire.
function mapsDir() { return path.join(app.getPath("userData"), "maps"); }
const SAFE_ID = /^[a-z0-9_]{1,40}$/;
function mapFileFor(id) {
  if (!SAFE_ID.test(String(id))) return null;
  const file = path.join(mapsDir(), `${id}.json`);
  // garde-fou anti path traversal : le fichier DOIT rester dans mapsDir.
  if (path.relative(mapsDir(), file).startsWith("..")) return null;
  return file;
}

// Fichier des armes (source unique partagée avec le serveur). En build packagé,
// ce fichier est dans l'asar (lecture seule) : l'écriture échoue proprement.
function weaponsFile() { return path.join(__dirname, "..", "public", "data", "weapons.json"); }

// Dossier des cartes du JEU (source de vérité lue par le serveur). « Publier »
// y écrit pour rendre une carte jouable en ligne (après redémarrage serveur).
// Réservé au mode dev (hors build packagé) : sinon écriture refusée.
function publicMapsDir() { return path.join(__dirname, "..", "public", "data", "maps"); }
function publicMapFileFor(id) {
  if (!SAFE_ID.test(String(id))) return null;
  const file = path.join(publicMapsDir(), `${id}.json`);
  if (path.relative(publicMapsDir(), file).startsWith("..")) return null;
  return file;
}

function registerStorageIpc() {
  ipcMain.handle("storage:load", async (_event, key) => {
    if (!ALLOWED_KEYS.has(key)) return null;
    try {
      const raw = await fs.readFile(fileFor(key), "utf8");
      return JSON.parse(raw);
    } catch {
      return null; // fichier absent ou corrompu : on laisse le client utiliser ses defaults
    }
  });

  ipcMain.handle("storage:save", async (_event, key, data) => {
    if (!ALLOWED_KEYS.has(key)) return false;
    try {
      await fs.mkdir(savesDir(), { recursive: true });
      await fs.writeFile(fileFor(key), JSON.stringify(data, null, 2), "utf8");
      return true;
    } catch (e) {
      console.error("[electron] échec de sauvegarde", key, e);
      return false;
    }
  });
}

function registerMapsIpc() {
  ipcMain.handle("maps:list", async () => {
    try {
      const files = await fs.readdir(mapsDir());
      const out = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const m = JSON.parse(await fs.readFile(path.join(mapsDir(), f), "utf8"));
          if (m && m.id) out.push({ id: m.id, name: m.name || m.id });
        } catch { /* fichier corrompu ignoré */ }
      }
      return out;
    } catch {
      return []; // dossier absent : aucune carte custom
    }
  });

  ipcMain.handle("maps:read", async (_event, id) => {
    const file = mapFileFor(id);
    if (!file) return null;
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  });

  ipcMain.handle("maps:write", async (_event, id, data) => {
    const file = mapFileFor(id);
    if (!file || !data || typeof data !== "object") return false;
    // Validation minimale du schéma (anti écriture de données arbitraires).
    if (data.id !== id || !Array.isArray(data.spawns) || !Array.isArray(data.covers)) return false;
    try {
      await fs.mkdir(mapsDir(), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
      return true;
    } catch (e) {
      console.error("[electron] écriture carte impossible", id, e);
      return false;
    }
  });

  // Publie une carte dans public/data/maps/ (source de vérité du jeu + serveur).
  // Réservé au mode dev : refusé en build packagé (et de toute façon en lecture seule dans l'asar).
  ipcMain.handle("maps:publish", async (_event, id, data) => {
    if (app.isPackaged && !process.env.ARENA_DEV) return false;
    const file = publicMapFileFor(id);
    if (!file || !data || typeof data !== "object") return false;
    if (data.id !== id || !Array.isArray(data.spawns) || !Array.isArray(data.covers)) return false;
    try {
      await fs.mkdir(publicMapsDir(), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
      return true; // NB : redémarrage serveur requis pour l'impact ONLINE.
    } catch (e) {
      console.error("[electron] publication carte impossible", id, e);
      return false;
    }
  });

  ipcMain.handle("maps:remove", async (_event, id) => {
    const file = mapFileFor(id);
    if (!file) return false;
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("weapons:write", async (_event, data) => {
    if (!data || typeof data !== "object" || !data.weapons || typeof data.weapons !== "object") return false;
    try {
      await fs.writeFile(weaponsFile(), JSON.stringify(data, null, 2), "utf8");
      return true; // NB : nécessite un redémarrage du serveur pour l'impact ONLINE.
    } catch (e) {
      console.error("[electron] écriture weapons.json impossible (build packagé ?)", e);
      return false;
    }
  });
}

// --- IPC Steam : surface minimale et validée exposée au renderer via preload. ---
function registerSteamIpc() {
  // Statut (disponibilité, AppID, joueur, cloud). Synchrone : lecture d'état en mémoire.
  ipcMain.handle("steam:status", () => steamStatus());

  // Débloque un succès. L'id est validé côté module (string non vide).
  ipcMain.handle("steam:unlockAchievement", (_event, id) => unlockAchievement(String(id)));

  // Retourne l'état de débloquage d'une liste d'ids.
  ipcMain.handle("steam:getAchievements", (_event, ids) =>
    getAchievements(Array.isArray(ids) ? ids.map(String) : []));

  // Cloud Steam (lecture/écriture de chaînes JSON). Confiné aux clés autorisées.
  const CLOUD_KEYS = new Set(["settings", "profile"]);
  ipcMain.handle("steam:cloudRead", (_event, name) => {
    if (!CLOUD_KEYS.has(name)) return { ok: false, reason: "clé non autorisée" };
    return cloudRead(`${name}.json`);
  });
  ipcMain.handle("steam:cloudWrite", (_event, name, content) => {
    if (!CLOUD_KEYS.has(name)) return { ok: false, reason: "clé non autorisée" };
    if (typeof content !== "string") return { ok: false, reason: "contenu invalide" };
    return cloudWrite(`${name}.json`, content);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    title: "Arena Duel",
    backgroundColor: "#0d0e10",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });

  await mainWindow.loadURL(USE_EMBEDDED ? `http://localhost:${PORT}` : SERVER_URL);
}

function stopServer() {
  if (serverInstance && typeof serverInstance.close === "function") {
    serverInstance.close();
    serverInstance = null;
  }
}

app.whenReady().then(async () => {
  registerStorageIpc();
  registerMapsIpc();
  registerSteamIpc();
  // Init Steam de façon SÛRE avant la fenêtre : ne lève jamais, log un avertissement
  // propre si le client Steam n'est pas lancé / lib indisponible (jeu jouable sans).
  initSteam();
  // Serveur local embarqué uniquement si l'URL pointe en local (sinon on joue sur Render).
  if (USE_EMBEDDED) serverInstance = startServer({ port: PORT, host: "127.0.0.1", exposeOnNetwork: false });
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});

app.on("before-quit", stopServer);
