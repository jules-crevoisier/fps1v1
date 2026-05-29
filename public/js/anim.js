// Moteur d'animation par keyframes — léger, SANS dépendance. Réutilisé partout
// (objets de carte, viewmodel d'arme) et piloté par la fenêtre d'animation (animator.js).
//
// Une animation est un CLIP de keyframes appliqué en DÉCALAGE par-dessus la pose de
// repos de l'objet (position/rotation placées dans l'éditeur) + un facteur d'échelle.
//
// Format clip :
//   { dur: secondes, loop: "loop"|"pingpong"|"once",
//     keys: [ { t, p:[dx,dy,dz], r:[rx,ry,rz] (rad), s: échelle, ease:"linear"|"smooth" } ] }
//
// Rétro-compat : ancien format simple { mode, dur, dp:[3], dr:[3] } encore lu.

export function hasAnim(a) {
  return !!(a && a.dur > 0 && ((Array.isArray(a.keys) && a.keys.length) || Array.isArray(a.dp) || Array.isArray(a.dr)));
}

const smooth = (f) => f * f * (3 - 2 * f);

/** Temps local [0..dur] selon le mode de bouclage. */
export function clipLocalTime(dur, loop, time) {
  if (dur <= 0) return 0;
  if (loop === "once") return Math.max(0, Math.min(dur, time));
  if (loop === "loop") return ((time % dur) + dur) % dur;
  // pingpong
  const ph = ((time % (2 * dur)) + 2 * dur) % (2 * dur);
  return ph <= dur ? ph : 2 * dur - ph;
}

/** Échantillonne un clip à keyframes → { p:[3], r:[3], s }. */
function sampleKeys(clip, time) {
  const keys = clip.keys;
  const lt = clipLocalTime(clip.dur || 1, clip.loop || "loop", time);
  // bornes
  if (lt <= keys[0].t) return keyVal(keys[0]);
  const last = keys[keys.length - 1];
  if (lt >= last.t) return keyVal(last);
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= lt) i++;
  const k0 = keys[i], k1 = keys[i + 1];
  const span = (k1.t - k0.t) || 1e-6;
  let f = (lt - k0.t) / span;
  if ((k1.ease || k0.ease) === "smooth") f = smooth(f);
  const a = keyVal(k0), b = keyVal(k1);
  return {
    p: [lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f), lerp(a.p[2], b.p[2], f)],
    r: [lerp(a.r[0], b.r[0], f), lerp(a.r[1], b.r[1], f), lerp(a.r[2], b.r[2], f)],
    s: lerp(a.s, b.s, f),
  };
}

const lerp = (a, b, f) => a + (b - a) * f;
function keyVal(k) {
  return { p: k.p || [0, 0, 0], r: k.r || [0, 0, 0], s: typeof k.s === "number" ? k.s : 1 };
}

/** Décalage { p:[3], r:[3], s } au temps donné (clip à keyframes OU ancien format). */
export function sampleAnim(anim, time) {
  if (Array.isArray(anim.keys) && anim.keys.length) return sampleKeys(anim, time);
  // ancien format simple (dp/dr, mode loop/pingpong)
  const dur = anim.dur || 1;
  const lt = clipLocalTime(dur, anim.mode || "loop", time);
  const f = lt / dur;
  const dp = anim.dp || [0, 0, 0], dr = anim.dr || [0, 0, 0];
  return { p: [dp[0] * f, dp[1] * f, dp[2] * f], r: [dr[0] * f, dr[1] * f, dr[2] * f], s: 1 };
}

/**
 * Avance une liste d'objets animés au temps absolu (s). Entrée :
 * { mesh, base:{pos:[3],rot:[3],scl?:number}, anim }. `skip` exclut un mesh
 * (figé à sa pose de repos — ex. objet sélectionné dans l'éditeur).
 */
export function updateAnimated(list, time, skip = null) {
  if (!list) return;
  for (const it of list) {
    if (!it || !it.mesh) continue;
    const bp = it.base.pos, br = it.base.rot, bs = it.base.scl ?? 1;
    if (skip && it.mesh === skip) {
      it.mesh.position.set(bp[0], bp[1], bp[2]);
      it.mesh.rotation.set(br[0], br[1], br[2]);
      it.mesh.scale.setScalar(bs);
      continue;
    }
    const o = sampleAnim(it.anim, time);
    it.mesh.position.set(bp[0] + o.p[0], bp[1] + o.p[1], bp[2] + o.p[2]);
    it.mesh.rotation.set(br[0] + o.r[0], br[1] + o.r[1], br[2] + o.r[2]);
    it.mesh.scale.setScalar(bs * (o.s ?? 1));
  }
}

/** Crée un clip vierge (2 keyframes neutres) prêt à éditer. */
export function makeClip(dur = 2, loop = "pingpong") {
  return {
    dur, loop,
    keys: [
      { t: 0, p: [0, 0, 0], r: [0, 0, 0], s: 1, ease: "smooth" },
      { t: dur, p: [0, 0, 0], r: [0, 0, 0], s: 1, ease: "smooth" },
    ],
  };
}

/** Convertit un ancien format simple (dp/dr) en clip à keyframes. */
export function migrateToClip(a) {
  if (!a) return makeClip();
  if (Array.isArray(a.keys) && a.keys.length) return a;
  const dur = a.dur || 2;
  return {
    dur, loop: a.mode || "pingpong",
    keys: [
      { t: 0, p: [0, 0, 0], r: [0, 0, 0], s: 1, ease: "smooth" },
      { t: dur, p: (a.dp || [0, 0, 0]).slice(), r: (a.dr || [0, 0, 0]).slice(), s: 1, ease: "smooth" },
    ],
  };
}
