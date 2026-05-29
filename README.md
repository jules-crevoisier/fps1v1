# ⚔ Arena Duel — FPS 1v1

Jeu de tir 1v1 dans le navigateur (Three.js) avec serveur autoritaire (Express + Socket.IO),
également empaquetable en application desktop Windows (Electron) **100 % hors-ligne**.

---

## 🚀 Démarrage rapide

> ⚠️ Windows / PowerShell : ne pas chaîner les commandes avec `&&`. Utiliser `;` ou des lignes séparées.

### Prérequis
- Node.js 18+ (testé sur Node 22)
- `npm install` à la racine du projet

```powershell
npm install
```

### 1. Mode web (navigateur)
```powershell
npm start
```
Puis ouvrir <http://localhost:3000>.

Pour exposer le serveur sur le réseau local (LAN) :
```powershell
npm run dev
```

### 2. Mode desktop (fenêtre Electron)
```powershell
npm run app:dev
```
Le serveur Express/Socket.IO est démarré **en interne** par Electron, puis une fenêtre
« Arena Duel » s'ouvre sur `http://localhost:3000`. Aucune connexion Internet requise.

### 3. Générer le `.exe` Windows
```powershell
npm run app:build
```
electron-builder produit dans `dist/` :
- un **installeur NSIS** (`Arena Duel Setup x.y.z.exe`),
- une version **portable** (`.exe` autonome).

> Le premier build télécharge les binaires Electron et peut être long. Une icône
> personnalisée peut être ajoutée via `build.win.icon` dans `package.json` (sinon icône
> Electron par défaut).

---

## 🗂️ Structure du projet

```
fps1v1/
├── server.js              # Serveur Express + Socket.IO (autoritaire). Exporte startServer().
├── package.json           # Scripts npm + config electron-builder
├── electron/
│   ├── main.js            # Process principal Electron (démarre le serveur + fenêtre + IPC Steam)
│   ├── steam.js           # Intégration Steamworks (init sûr, succès, cloud) — main process only
│   └── preload.cjs        # Pont IPC sécurisé (window.arenaDesktop) — pas de nodeIntegration
├── public/
│   ├── index.html         # Page du jeu (importmap Three.js LOCAL, polices LOCALES)
│   ├── css/style.css
│   ├── data/              # ▼ Données de jeu (source de vérité, cible de l'éditeur)
│   │   ├── weapons.json    #   Stats d'armes (lues par le client ET le serveur)
│   │   └── maps/
│   │       ├── arena.json   #   Carte « Arène »
│   │       └── tours.json   #   Carte « Tours »
│   ├── assets/            # ▼ Assets utilisateur (offline)
│   │   ├── models/         #   Modèles glTF/GLB (props de carte)
│   │   └── textures/       #   Textures (sol, blocs)
│   ├── vendor/            # ▼ Dépendances hébergées en local (offline)
│   │   ├── three/three.module.js
│   │   ├── three/addons/   #   OrbitControls, TransformControls, GLTFLoader (vendus)
│   │   └── fonts/         #   Oswald + Inter (woff2) + fonts.css
│   └── js/
│       ├── main.js         # Boucle de jeu, rendu, boot + intégration éditeur
│       ├── config.js       # Données + persistance (USER/PROFILE) + (de)sérialisation armes
│       ├── storage.js      # Couche de sauvegarde (fichier Electron / localStorage web / Steam Cloud)
│       ├── steam.js        # Wrapper Steam côté renderer (succès, cloud) — no-op hors Steam
│       ├── arena.js        # Construit la map à partir des JSON (registerMap, buildArenaFromData)
│       ├── editor/         # ▼ Éditeur intégré (mode ÉDITEUR)
│       │   ├── editor.js     #   Scène d'édition, caméra orbitale, gizmos, outils
│       │   ├── editorUI.js   #   Panneaux (outils, liste, propriétés, actions)
│       │   ├── mapStore.js   #   Persistance cartes custom (IPC / localStorage) + export/import
│       │   ├── weaponsEditor.js # Éditeur d'armes (stats live)
│       │   └── assets.js     #   Chargement glTF + textures (offline)
│       └── ... (player, bot, ui, network, viewmodel, etc.)
└── docs/roadmap.md        # Suite du projet (phases 2 & 3)
```

---

## 🎮 Contrôles
**ZQSD/WASD** bouger · **Alt** marcher · **Souris** viser · **Clic** tirer · **Espace** sauter ·
**Ctrl** slide · **R** recharger · **1/2** armes · **Entrée** chat · **Échap** pause.

---

## ⚙️ Réglages (onglet Paramètres)
- Sensibilité souris, FOV.
- **Qualité graphique** (Bas / Moyen / Élevé) : pilote le pixel ratio, les ombres
  (activation + taille de shadow map) et l'antialiasing.
- **Limite FPS** (illimité / 30 / 60 / 120 / 144 / 240).
- **Compteur FPS** (affichage optionnel en jeu).

Tous les réglages sont persistés (fichier en desktop, `localStorage` en web).

---

## 💾 Système de sauvegarde
`public/js/storage.js` fournit une API unique :
- **En Electron** : fichiers JSON dans le dossier `userData` de l'app
  (`%AppData%/Arena Duel/saves/settings.json` et `profile.json`), via IPC sécurisé.
- **En web** : `localStorage` (`arena_settings`, `arena_profile`).

Les données sont **versionnées** (`version`) et **validées** au chargement : un fichier
corrompu ou des champs invalides n'entraînent jamais de crash (retour aux valeurs par défaut).

---

## 📐 Format des fichiers de données

### `public/data/weapons.json`
Source de vérité **unique** des armes, lue par le client (UI, rendu, recul) **et** par le
serveur (résolution autoritaire des tirs : `damage`, `fireRate`, `range`, `headshotMult`, `pellets`).

```jsonc
{
  "version": 1,
  "weapons": {
    "rifle": {
      "name": "Fusil d'assaut",
      "slot": "primary",          // "primary" | "secondary"
      "unlock": 1,                 // niveau joueur requis
      "damage": 22, "fireRate": 9, "mag": 30, "reload": 2.0,
      "spread": 0.008, "auto": true, "range": 200,
      "color": "#ff9e2c",          // teinte du tracer (hex string)
      "recoil": 0.013, "recoilH": 0.5, "shake": 0.05,
      "headshotMult": 2.0,         // optionnel
      "pellets": 9                 // optionnel (fusil à pompe)
    }
  }
}
```

### `public/data/maps/<id>.json`
Décrit entièrement une carte. `buildArena()` la construit dynamiquement.

```jsonc
{
  "version": 1,
  "id": "arena",
  "name": "Arène",
  "size": 60,                       // taille de l'arène
  "floorColor": "#2b3850",
  "background": "#141b26",
  "wallColor": "#222d3d",
  "coverColor": "#2b3a4f",
  "accentColor": "#ff9e2c",
  "fog": { "color": "#141b26", "near": 70, "far": 190 },
  "lights": {
    "hemisphere":  { "sky": "#bfd8ff", "ground": "#40464f", "intensity": 1.35 },
    "directional": { "color": "#ffffff", "intensity": 1.9, "position": [20, 40, 15],
                     "castShadow": true, "shadowMapSize": 2048 },
    "fill":        { "color": "#8fb0ff", "intensity": 0.5, "position": [-25, 20, -20] },
    "ambient":     { "color": "#55657a", "intensity": 0.7 }
  },
  "covers": [
    { "pos": [0, 1.5, 0], "size": [4, 3, 4], "accent": true }  // accent = teinte ambre
  ],
  "spawns": [ [-24, 1.7, -24], [24, 1.7, 24] ],                // points d'apparition
  "pickups": [
    { "id": "heal_arena_1", "type": "heal", "pos": [0, 1.7, 0], "healAmount": 35 }
  ]
}
```
> Les couleurs sont des chaînes CSS `#rrggbb`. Les `pickups` d'une carte pilotent les
> soins du **mode en ligne** (lus aussi par le serveur). La taille de la shadow map est
> écrasée par le réglage Qualité graphique en jeu.

---

## 🛠️ Éditeur intégré (cartes + armes)

L'éditeur est **intégré au jeu** : depuis le menu principal, onglet **JOUER**, cliquez sur
**« ÉDITEUR DE CARTES »**. Il ouvre une scène 3D à **caméra orbitale** (clic-glisser pour
tourner autour, molette pour zoomer) — ce que vous éditez est rendu **exactement** comme en
jeu (WYSIWYG, via la logique de `buildArena`).

### Éditer une carte
- **Barre d'outils (haut)** : `+ Bloc`, `+ Spawn`, `+ Soin`, `Dupliquer`, `Supprimer`,
  modes de gizmo `Déplacer` / `Tourner` / `Redim.`, **grille de snapping** (case + pas).
- **Sélection** : clic sur un objet (un gizmo apparaît). Raccourcis : `G` déplacer,
  `R` tourner, `T` redimensionner, `Ctrl+D` dupliquer, `Suppr` supprimer, `Échap` désélectionner.
- **Panneau gauche** : sélecteur de carte (intégrées / personnalisées / **Vierge**) et liste
  des objets.
- **Panneau droit** : propriétés **live** de l'objet sélectionné (position X/Y/Z, taille
  L/H/P, rotation, accent ambre, soin en PV). Sans sélection, il affiche les **réglages
  globaux** : nom, taille d'arène, couleurs (sol, fond, murs, blocs, accent), brouillard.

### Tester / Sauvegarder / Partager
- **▶ Tester (solo)** : lance immédiatement une partie vs bot sur la carte en cours
  d'édition ; à la sortie (Échap → Quitter, ou fin de partie → Menu) vous **revenez à l'éditeur**.
- **💾 Sauvegarder** : écrit un fichier JSON au **même format** que `public/data/maps/*.json`.
  - **Desktop (Electron)** : dans `userData/maps/<id>.json` (via IPC sécurisé).
  - **Web (navigateur)** : dans `localStorage`.
  - Dans les deux cas, la carte apparaît ensuite dans le **sélecteur « Carte »** du menu et
    est **jouable en solo**.
- **Exporter JSON / Importer JSON** : télécharger / recharger une carte en fichier `.json`
  (partage manuel, sauvegarde externe).

> ⚠️ **Cartes custom en ligne** : le serveur ne connaît que les cartes **intégrées**
> (`arena`, `tours`). Les cartes personnalisées sont jouables en **solo** uniquement. Pour
> les utiliser en ligne, ajoutez le fichier à `public/data/maps/` et déclarez son `id` dans
> `server.js` (liste `MAP_DATA`), puis redémarrez le serveur.

### Éditeur d'armes
Bouton **« Armes »** dans la barre d'outils de l'éditeur. Édition **live** (sliders + champs)
de toutes les stats de `public/data/weapons.json` : dégâts, cadence, chargeur, recharge,
portée, dispersion, recul, secousse, multiplicateur tête, plombs, niveau requis, couleur,
auto.
- **Appliquer (solo)** : met à jour les armes en mémoire → visible **dès la prochaine partie solo**.
- **💾 Sauvegarder** : écrit `public/data/weapons.json` (Electron en dev) ou propose un export
  (web). **Le serveur lit `weapons.json` au démarrage** : un **redémarrage du serveur** est
  nécessaire pour que le mode **EN LIGNE** prenne en compte les changements. En build packagé
  (`.exe`), `weapons.json` est en lecture seule (dans l'asar) → utilisez **Exporter** puis
  remplacez le fichier source.

### Assets (textures & modèles 3D)
- **Modèles glTF/GLB** : déposez vos fichiers dans `public/assets/models/` et référencez-les
  via le tableau `props` d'une carte (`{ "model": "assets/models/x.glb", "pos": [...] }`). Le
  bouton **« Modèle .glb »** de l'éditeur permet d'importer un fichier pour **prévisualisation**.
- **Textures** : déposez-les dans `public/assets/textures/` et utilisez le champ
  `"floorTexture": "assets/textures/x.jpg"` d'une carte pour texturer le sol.
- Le chargeur `GLTFLoader` et les contrôles `OrbitControls` / `TransformControls` sont
  **vendus localement** dans `public/vendor/three/addons/` (100 % hors-ligne).
- Détails et conventions : voir `public/assets/models/README.md` et
  `public/assets/textures/README.md`.

---

## 🎮 Intégration Steam (optionnelle)

Le jeu intègre une **couche Steam optionnelle** (succès + sauvegardes cloud) via
[`steamworks.js`](https://github.com/ceifa/steamworks.js). Elle est **100 % facultative** :
sans client Steam lancé, en mode web, ou si la lib est indisponible, le jeu tourne
**exactement pareil** (dégradation gracieuse, aucun plantage).

> ⚠️ Le module natif `steamworks.js` n'est utilisé que dans le **process principal
> Electron**. Il n'est **jamais** importé dans le renderer ni en mode web : tout passe
> par des canaux IPC sécurisés (`steam:*`) + le wrapper client `public/js/steam.js`.

### Tester en développement (AppID 480)
On utilise l'**AppID de test public `480` (Spacewar)** pour développer sans compte
Steamworks Partner.

1. Lancer le **client Steam** et y être connecté.
2. Créer un fichier `steam_appid.txt` à la **racine** du projet contenant uniquement :
   ```
   480
   ```
   > Ce fichier est **gitignoré** (propre à l'environnement de dev). En build packagé,
   > Steam fournit lui-même l'AppID, le fichier n'est pas nécessaire.
3. Lancer le jeu en desktop :
   ```powershell
   npm run app:dev
   ```
4. Dans la console du **process principal**, un log `[steam]` confirme l'init :
   - Steam lancé → `Steam initialisé (AppID 480) — joueur: …, cloud: …`
   - Steam absent → `init Steam échouée (client Steam non lancé ?) — le jeu continue sans Steam.`

> 🔎 **Succès non visibles avec l'AppID 480** : c'est **attendu**. Les succès ne sont
> pas déclarés dans le backend de Spacewar, donc `ActivateAchievement` réussit l'appel
> mais n'affiche aucune notification. Un mode **debug** (`STEAM_DEBUG=1`, activé d'office
> avec l'AppID 480) logue chaque appel pour confirmer qu'il a bien lieu.

### Passer au vrai AppID (publication)
**Une seule source à modifier** : la constante `STEAM_APP_ID` dans `electron/steam.js`
(ou la variable d'environnement `STEAM_APP_ID`). Ensuite :
1. Créer la fiche app dans **Steamworks** (compte Partner) → obtenir le vrai AppID.
2. Déclarer les **succès** dans Steamworks avec les **mêmes API Names** que
   `public/data/achievements.json` (`ACH_FIRST_WIN`, `ACH_WIN_10`, …).
3. Activer le **Steam Cloud** (Auto-Cloud ou quota Remote Storage) pour la fiche app.
4. Mettre à jour `STEAM_APP_ID`, builder, et déposer sur Steam (voir ci-dessous).

### Succès implémentés
Définis dans `public/data/achievements.json`, déclenchés aux endroits réels du gameplay :

| API Name | Condition | Déclencheur |
|---|---|---|
| `ACH_FIRST_WIN` | Première victoire | `endGame(win=true)` |
| `ACH_WIN_10` | 10 victoires cumulées | stats du profil (fin de partie) |
| `ACH_KILLS_100` | 100 éliminations cumulées | stats du profil (fin de partie) |
| `ACH_FIRST_HEADSHOT` | Premier headshot | `onOpponentKilled(headshot)` |
| `ACH_LEVEL_5` | Niveau joueur 5 | stats du profil (fin de partie) |
| `ACH_FLAWLESS` | Gagner sans mourir | `endGame` (score adverse = 0) |
| `ACH_EDITOR_SAVE` | Sauvegarder une carte | éditeur (`_save`) |
| `ACH_EDITOR_TEST` | Tester une carte | éditeur (`startEditorTest`) |

Les appels sont **idempotents** (anti-spam local + `isActivated` côté Steam).

### Sauvegardes Cloud (Steam Remote Storage)
`public/js/storage.js` pousse les sauvegardes (`settings`, `profile`) vers le Cloud
quand Steam est disponible :
- **Au boot** : compare la version locale et la version cloud via un timestamp `_ts`
  et garde la **plus récente** (réaligne le local si le cloud est plus frais).
- **À chaque sauvegarde** : écrit **localement** (fichier userData / `localStorage`)
  **ET** pousse au Cloud (best-effort, jamais bloquant).
- **Résolution de conflit** : **dernier écrit gagne** (`_ts` = `Date.now()` à l'écriture).

Si le Cloud échoue ou est indisponible, seules les sauvegardes locales sont utilisées —
le jeu n'est jamais bloqué.

### Build / dépôt Steam (haut niveau)
- **electron-builder** est configuré (`asarUnpack`) pour sortir les binaires natifs de
  `steamworks.js` (`.node`, `steam_api64.dll`) **hors de l'asar** (obligatoire pour le
  chargement du module natif). Build : `npm run app:build`.
- **Icône d'app** : ajouter `build.win.icon` dans `package.json` pointant vers un
  `.ico` (ex. `build/icon.ico`, 256×256). Non fourni ici → icône Electron par défaut.
- **Dépôt sur Steam (SteamPipe)**, une fois le vrai AppID obtenu :
  1. Installer **steamcmd**.
  2. Définir l'**app** (vrai AppID) et un ou plusieurs **depots** dans des scripts VDF
     (`app_build_<appid>.vdf` + `depot_build_<depotid>.vdf`).
  3. Pointer le `ContentRoot` du depot sur le dossier `dist/win-unpacked` (ou l'output
     portable) produit par electron-builder.
  4. Uploader : `steamcmd +login <partner> +run_app_build app_build_<appid>.vdf +quit`.
  5. Affecter le build à une **branche** (`default`/`beta`) depuis le Steamworks, puis
     publier. Signer le `.exe` (certificat Windows) pour éviter SmartScreen.

---

## 🏗️ Architecture technique (décisions)
- **Serveur embarqué dans Electron** : `electron/main.js` importe et appelle `startServer()`
  de `server.js` dans le même process (pas de child process à superviser) ; le serveur est
  arrêté proprement à la fermeture. `server.js` ne s'auto-démarre que lancé directement
  (`node server.js`).
- **Offline total** : Three.js et les polices Oswald/Inter sont vendus dans `public/vendor/`.
  L'importmap et le CSS pointent vers ces fichiers locaux (plus aucun appel à unpkg ou
  Google Fonts).
- **Source de vérité unique** : armes et maps en JSON, lues par le client et le serveur.
- **Sécurité Electron** : `contextIsolation` activé, `nodeIntegration` désactivé, `sandbox`
  activé ; l'accès fichier passe par des handlers IPC **restreints et validés** :
  `storage:load`/`storage:save` (réglages/profil), `maps:list|read|write|remove` (cartes
  custom, **id validé** `^[a-z0-9_]+$` + garde anti path-traversal, confinées à
  `userData/maps`), et `weapons:write` (écrit `public/data/weapons.json`, schéma minimal validé).
- **Addons Three.js vendus** : `OrbitControls`, `TransformControls`, `GLTFLoader`
  (+ `BufferGeometryUtils`) copiés dans `public/vendor/three/addons/` ; l'importmap
  `three/addons/` pointe en local (aucun CDN). `GLTFLoader` est importé **dynamiquement**
  (chargé seulement si une carte utilise des modèles).
- **Steam optionnel & isolé** : le module natif `steamworks.js` vit dans le **process
  principal** (`electron/steam.js`), jamais dans le renderer. L'init est protégée par
  `try/catch` (jamais de plantage si Steam est absent) et expose un état `available`.
  Le renderer y accède via IPC (`steam:*`) et le wrapper `public/js/steam.js`, qui est
  un **no-op silencieux** en mode web. **Source unique de l'AppID** : `STEAM_APP_ID`.

Voir `docs/roadmap.md` pour la suite (éditeur de map, export Steam).
