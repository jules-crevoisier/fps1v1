# 🗺️ Roadmap — Arena Duel

## ✅ Phase 1 — Fondations (terminée)
- Wrapper **Electron** + configuration **electron-builder** (cibles `nsis` + `portable`).
  Scripts : `npm run app:dev`, `npm run app:build`.
- **Offline total** : Three.js (`public/vendor/three/`) et polices Oswald/Inter
  (`public/vendor/fonts/`) hébergés en local ; importmap et CSS sans CDN.
- **Système de sauvegarde** (`public/js/storage.js`) : fichiers JSON en Electron (userData
  via IPC sécurisé), `localStorage` en web. Données versionnées + validées.
- **Données externalisées en JSON** : armes (`public/data/weapons.json`) et cartes
  (`public/data/maps/*.json`), lues par le client **et** le serveur (source unique).
- **Passe d'optimisation FPS** : `powerPreference: "high-performance"`, partage de
  géométries, presets de qualité (pixel ratio / ombres / shadow map / antialias),
  cap FPS et compteur FPS optionnels.

---

## ✅ Phase 2 — Engine maison / Éditeur (terminée)
Objectif : éditer cartes et armes sans toucher au code. **Fait.**

1. ✅ **Éditeur de map intégré** (mode « ÉDITEUR » du menu, `public/js/editor/`) :
   - Caméra **orbitale** (`OrbitControls`) + gizmos (`TransformControls`) : déplacer,
     tourner (yaw), redimensionner les blocs ; snapping à une grille configurable.
   - Création/sélection/duplication/suppression de **blocs**, **spawns**, **pickups (heal)**.
   - Édition **live** des couleurs (sol, fond, murs, blocs, accent), taille d'arène, brouillard.
   - Panneau UI : barre d'outils, liste d'objets, propriétés de la sélection, sélecteur de carte
     (intégrées / personnalisées / vierge).
   - **WYSIWYG** : le rendu réutilise `buildArenaFromData` (même logique qu'en jeu).
   - **Tester** (partie solo immédiate sur la carte éditée, retour éditeur ensuite).
   - **Sauvegarde** au format `public/data/maps/*.json` : `userData/maps` (Electron, IPC validé)
     ou `localStorage` (web) ; **export/import** par fichier `.json`. Les cartes custom
     apparaissent dans le menu et sont jouables en **solo**.
2. ✅ **Éditeur d'armes** : UI sliders/champs éditant `weapons.json` ; « Appliquer » (solo
   live) + « Sauvegarder » (IPC `weapons:write` / export web).
3. ✅ **Gestion d'assets** : addons Three.js **vendus** (`OrbitControls`, `TransformControls`,
   `GLTFLoader`) ; chargement `.glb/.gltf` (import + champ `props` des cartes) et **textures**
   de sol (`floorTexture`), référencés par chemin relatif (`public/assets/...`).

### Reste pour solidifier (optionnel)
- **Validation de schéma** centralisée (Zod / JSON Schema) partagée client/serveur/éditeur.
- Édition des **props/lumières** directement au gizmo (actuellement props = prévisualisation
  + champ JSON ; lumières = valeurs par défaut de la carte).
- **Cartes custom en ligne** : nécessiterait que le serveur accepte une carte fournie/validée
  par le client (aujourd'hui le serveur n'autorise que `arena`/`tours`).

---

## ✅ Phase 3 — Intégration Steam (« prêt à brancher », AppID de test 480)
Couche Steam **optionnelle** intégrée et testable en dev avec l'AppID public `480`
(Spacewar), sans compte Partner. **Dégradation gracieuse totale** : sans client Steam,
en mode web ou si la lib échoue, le jeu fonctionne normalement.

1. ✅ **Lib Steamworks** : `steamworks.js` ajoutée en dependency (binaires natifs
   précompilés win/linux/mac). Utilisée **uniquement** dans le process principal
   (`electron/steam.js`). `steam_appid.txt`=`480` à la racine (gitignoré, dev only).
2. ✅ **Init sûre** : `initSteam()` après `app.whenReady()`, protégée par `try/catch` ;
   expose un état `available`/`cloudEnabled` ; **source unique** de l'AppID via
   `STEAM_APP_ID` (constante ou env). Overlay Electron activé si dispo.
3. ✅ **IPC sécurisé** : canaux `steam:status|unlockAchievement|getAchievements|cloudRead|cloudWrite`
   (validés, clés cloud restreintes) + wrapper renderer `public/js/steam.js` (no-op hors Steam).
4. ✅ **Succès** : 8 succès cohérents (`public/data/achievements.json`) branchés sur les
   déclencheurs réels (1re victoire, 10 victoires, 100 kills, headshot, niveau 5, manche
   parfaite, sauvegarde/test de carte). Appels **idempotents**.
5. ✅ **Cloud saves** : `storage.js` écrit en local **et** pousse au Steam Cloud ;
   au boot, choisit la version la plus récente (`_ts`, dernier écrit gagne). Jamais bloquant.
6. ✅ **Build** : `electron-builder` configuré (`asarUnpack`) pour sortir les binaires
   natifs de `steamworks.js` hors de l'asar.

### Reste pour une publication réelle
- **Compte Steamworks Partner** + création de la **fiche app** → obtention du **vrai AppID**.
- Remplacer `STEAM_APP_ID` (constante `electron/steam.js` ou env) par le vrai AppID.
- **Déclarer les succès** dans Steamworks avec les **mêmes API Names** que
  `achievements.json` (sinon ils ne s'affichent pas — limitation attendue avec l'AppID 480).
- **Activer le Steam Cloud** (Auto-Cloud / quota Remote Storage) sur la fiche app.
- **Icône d'app** (`build.win.icon` → `.ico`) et **signature de code** (certificat Windows,
  anti-SmartScreen).
- **Dépôt SteamPipe** : depots + scripts VDF + `steamcmd` + branches (beta/release).
- *(Optionnel)* Remplacer/compléter le matchmaking Socket.IO par des **lobbies Steam**
  (P2P) pour le jeu en ligne sans serveur central.

---

## 💡 Pistes complémentaires
- Tests automatisés (Vitest pour la logique serveur de résolution des tirs).
- Compression Brotli/gzip des assets statiques côté Express.
- Profil de performance (Spector.js / Stats.js) pour cibler les optimisations GPU.
- Anti-triche serveur renforcé (déjà partiellement autoritaire).
