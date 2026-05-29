# Textures

Déposez ici vos textures (`.jpg`, `.png`, `.webp`), servies par Express depuis `public/`.

## Convention
Référencement par **chemin relatif à `public/`**. Exemple : texture de sol d'une carte.

```jsonc
{
  "floorTexture": "assets/textures/concrete.jpg"
}
```

La texture est appliquée au matériau du sol en **répétition** (tiling) automatique,
proportionnelle à la taille de l'arène. Une texture absente est ignorée sans erreur
(le rendu retombe sur la couleur unie `floorColor`).

> Préférez des textures « tileables » (sans coutures) et de résolution raisonnable
> (1024² ou 2048²) pour de bonnes performances.
