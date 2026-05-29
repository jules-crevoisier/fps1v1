# Modèles 3D (glTF / GLB)

Déposez ici vos modèles `.glb` ou `.gltf` (offline, servis par Express depuis `public/`).

## Convention
- Format recommandé : **`.glb`** (binaire, un seul fichier, plus simple à distribuer).
- Référencement dans une carte JSON via le tableau `props`, en **chemin relatif à `public/`** :

```jsonc
{
  "props": [
    { "model": "assets/models/crate.glb", "pos": [4, 0, -6], "rot": 0, "scale": 1 }
  ]
}
```

## Utilisation dans l'éditeur
- Bouton **« Modèle .glb »** : importe un fichier local pour **prévisualisation** dans la
  scène (placé à l'origine). Pour le **conserver**, copiez le fichier dans ce dossier et
  ajoutez une entrée `props` à la carte (le moteur le rechargera via `assets/models/...`).
- Le chargeur (`GLTFLoader`) est vendu **localement** dans
  `public/vendor/three/addons/loaders/` — aucun CDN, 100 % hors-ligne.

> Astuce : gardez des modèles légers (quelques Mo max) pour préserver les performances et
> la taille du build desktop.
