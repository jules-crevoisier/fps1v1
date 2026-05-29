// Éditeur d'armes : édite les stats de public/data/weapons.json via une UI live.
//
// - « Appliquer (solo) » met à jour WEAPONS en mémoire : la prochaine partie solo
//   reflète immédiatement les nouvelles stats.
// - « Sauvegarder » écrit le fichier weapons.json (Electron, via IPC) ou propose un
//   export .json (web). Le SERVEUR lit weapons.json au démarrage : un redémarrage du
//   serveur est nécessaire pour que le mode EN LIGNE prenne en compte les changements.

import * as THREE from "three";
import { WEAPONS, serializeWeapons, applyWeaponsData, weaponColor } from "../config.js";
import { ViewModel } from "../viewmodel.js";
import { Animator } from "./animator.js";
import { sampleAnim, migrateToClip } from "../anim.js";

const WEAPON_EVENTS = [["idle", "Idle (boucle)"], ["fire", "Tir"], ["reload", "Recharge"], ["equip", "Équiper"]];

const desktopWeapons = (typeof window !== "undefined" && window.arenaDesktop && window.arenaDesktop.weapons)
  ? window.arenaDesktop.weapons : null;

// Champs numériques éditables (label, clé, min, max, pas).
const NUM_FIELDS = [
  ["Dégâts", "damage", 1, 200, 1],
  ["Cadence (tirs/s)", "fireRate", 0.5, 20, 0.1],
  ["Chargeur", "mag", 1, 200, 1],
  ["Recharge (s)", "reload", 0.3, 6, 0.1],
  ["Portée", "range", 10, 500, 5],
  ["Dispersion", "spread", 0, 0.1, 0.001],
  ["Recul vertical", "recoil", 0, 0.2, 0.001],
  ["Recul horizontal", "recoilH", 0, 2, 0.05],
  ["Secousse", "shake", 0, 0.5, 0.005],
  ["Mult. tête", "headshotMult", 1, 4, 0.05],
  ["Plombs", "pellets", 1, 16, 1],
  ["Niveau requis", "unlock", 1, 20, 1],
];

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.appendChild(c);
  return e;
}

let _instance = null;

class WeaponsEditor {
  constructor() {
    this.data = serializeWeapons();   // { version, weapons }
    this.currentId = Object.keys(this.data.weapons)[0] || null;
    this._build();
  }

  _build() {
    this.list = el("div", { class: "ed-list" });
    this.fields = el("div", { class: "ed-props" });
    this.fileInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none",
      onchange: (e) => this._import(e) });
    this.toastEl = el("div", { class: "ed-toast hidden" });

    const left = el("div", { class: "we-left" }, [
      el("div", { class: "ed-section-title", text: "ARMES" }),
      el("button", { class: "ed-btn sm primary", text: "+ Nouvelle arme", onclick: () => this._addWeapon() }),
      this.list,
    ]);
    // Onglets : STATS & MODÈLE / ANIMATION
    this.tab = "stats";
    this.tabStats = el("button", { class: "ed-btn sm primary", text: "Stats & modèle", onclick: () => this._setTab("stats") });
    this.tabAnim = el("button", { class: "ed-btn sm", text: "Animation", onclick: () => this._setTab("anim") });
    const tabBar = el("div", { class: "we-tabs" }, [this.tabStats, this.tabAnim]);

    this.statsPane = el("div", { class: "we-pane" }, [
      el("div", { class: "ed-section-title", text: "STATS & MODÈLE" }), this.fields,
    ]);

    this.previewWrap = el("div", { class: "we-previewwrap" });
    this.animEvents = el("div", { class: "ed-props" });
    this.animPane = el("div", { class: "we-pane hidden" }, [
      this.previewWrap,
      el("div", { class: "ed-section-title", text: "CLIPS D'ANIMATION" }), this.animEvents,
    ]);

    const right = el("div", { class: "we-right" }, [tabBar, this.statsPane, this.animPane]);
    this.animator = new Animator();
    this.preview = new WeaponPreview(this.previewWrap, this.animator);
    const bar = el("div", { class: "ed-bottom" }, [
      el("button", { class: "ed-btn primary", text: "Appliquer (solo)", onclick: () => this._apply() }),
      el("button", { class: "ed-btn", text: "💾 Sauvegarder", onclick: () => this._save() }),
      el("button", { class: "ed-btn", text: "Exporter JSON", onclick: () => this._export() }),
      el("button", { class: "ed-btn", text: "Importer JSON", onclick: () => this.fileInput.click() }),
      el("button", { class: "ed-btn ghost", text: "Fermer", onclick: () => this.hide() }),
    ]);
    this.root = el("div", { class: "we-root hidden" }, [
      el("div", { class: "ed-brand we-title", html: "ÉDITEUR<span>D'ARMES</span>" }),
      left, right, bar, this.toastEl, this.fileInput,
    ]);
    document.body.appendChild(this.root);
    this._renderList();
    this._renderFields();
    this._setTab("stats");
  }

  _setTab(tab) {
    this.tab = tab;
    const anim = tab === "anim";
    this.statsPane.classList.toggle("hidden", anim);
    this.animPane.classList.toggle("hidden", !anim);
    this.tabStats.classList.toggle("primary", !anim);
    this.tabAnim.classList.toggle("primary", anim);
    if (anim) { this._renderAnimPage(); this.preview.start(); this._syncPreview(); }
    else { this.preview.stop(); this.animator.close(); }
  }

  show() {
    this.root.classList.remove("hidden");
    this._setTab(this.tab);   // resynchronise l'onglet courant (préview + page anim)
  }
  hide() {
    this.root.classList.add("hidden");
    this.preview.stop();
    this.animator.close();
  }

  _syncPreview() {
    const w = this.data.weapons[this.currentId];
    if (w) this.preview.setWeapon(this.currentId, w.color || "#ffd27a");
  }

  _renderList() {
    this.list.innerHTML = "";
    for (const [id, w] of Object.entries(this.data.weapons)) {
      const item = el("div", {
        class: "ed-list-item" + (id === this.currentId ? " active" : ""),
        html: `<span style="color:${w.color}">●</span> ${w.name || id} <small>${w.slot || ""}</small>`,
        onclick: () => { this.currentId = id; this.animator.close(); this._renderList(); this._renderFields(); if (this.tab === "anim") this._renderAnimPage(); this._syncPreview(); },
      });
      this.list.appendChild(item);
    }
  }

  _renderFields() {
    this.fields.innerHTML = "";
    const w = this.data.weapons[this.currentId];
    if (!w) return;
    this.fields.appendChild(el("div", { class: "ed-prop-head", text: w.name || this.currentId }));
    this.fields.appendChild(this._textRow("Nom", "name", w.name || ""));
    this.fields.appendChild(this._slotRow(w.slot || "primary"));
    this.fields.appendChild(this._colorRow("Couleur (tracer)", w.color || "#ffffff"));
    this.fields.appendChild(this._checkRow("Automatique", "auto", !!w.auto));
    for (const [label, key, min, max, step] of NUM_FIELDS) {
      // headshotMult / pellets sont optionnels : on n'affiche le champ que si pertinent
      if ((key === "headshotMult" || key === "pellets") && w[key] == null) {
        this.fields.appendChild(this._optionalRow(label, key, min, max, step));
      } else {
        this.fields.appendChild(this._numRow(label, key, w[key] ?? min, min, max, step));
      }
    }
    // Modèle 3D (viewmodel)
    this._modelSection(w);

    // suppression de l'arme courante
    this.fields.appendChild(el("div", { class: "ed-row", style: "margin-top:10px" }, [
      el("button", { class: "ed-btn sm danger", text: "🗑 Supprimer cette arme", onclick: () => this._deleteWeapon() }),
    ]));
  }

  _modelSection(w) {
    this.fields.appendChild(el("div", { class: "ed-prop-head", text: "Modèle 3D (vue FPS)" }));
    const vm = w.viewModel;
    if (!vm || !vm.model) {
      this.fields.appendChild(el("div", { class: "ed-prop-row" }, [
        el("input", { type: "text", class: "ed-text", placeholder: "assets/models/arme.glb",
          onchange: (e) => { const v = e.target.value.trim(); if (v) { this._setVM("model", v); this._renderFields(); } } }),
      ]));
      this.fields.appendChild(el("div", { class: "ed-prop-note",
        text: "Placez le .glb dans public/assets/models/ puis indiquez son chemin. Sinon, modèle procédural par défaut." }));
      return;
    }
    this.fields.appendChild(this._textRowVM("Chemin GLB", "model", vm.model));
    this.fields.appendChild(this._numRowVM("Échelle", "scale", vm.scale ?? 1, 0.05, 10, 0.05));
    this.fields.appendChild(this._vec3RowVM("Position (X/Y/Z)", "pos", vm.pos || [0.18, -0.18, -0.40], 0.01));
    this.fields.appendChild(this._vec3RowVM("Rotation (rad X/Y/Z)", "rot", vm.rot || [0, 0, 0], 0.05));
    this.fields.appendChild(el("div", { class: "ed-row" }, [
      el("button", { class: "ed-btn sm danger", text: "Retirer le modèle",
        onclick: () => { delete this.data.weapons[this.currentId].viewModel; this._renderFields(); } }),
    ]));
  }

  _setVM(key, val) {
    const w = this.data.weapons[this.currentId];
    w.viewModel ||= {};
    w.viewModel[key] = val;
  }

  _renderAnimPage() {
    const c = this.animEvents;
    c.innerHTML = "";
    const w = this.data.weapons[this.currentId];
    if (!w) return;
    c.appendChild(el("div", { class: "ed-prop-note", text: w.name || this.currentId }));
    const clips = w.viewModel?.clips || {};
    for (const [ev, label] of WEAPON_EVENTS) {
      const has = !!clips[ev];
      const row = el("div", { class: "ed-prop-row" }, [
        el("label", { text: label + (has ? ` · ${clips[ev].keys?.length || 0} clés` : "") }),
        el("button", { class: "ed-btn sm" + (has ? " primary" : ""), text: has ? "🎬 Éditer" : "+ Créer",
          onclick: () => this._editWeaponClip(ev, label) }),
      ]);
      if (has) row.appendChild(el("button", { class: "ed-btn sm danger", text: "✕",
        onclick: () => { delete w.viewModel.clips[ev]; this.animator.close(); this._renderAnimPage(); } }));
      c.appendChild(row);
    }
    c.appendChild(el("div", { class: "ed-prop-note",
      text: "Idle = boucle continue · Tir/Recharge/Équiper = joués une fois sur l'événement." }));
  }

  _editWeaponClip(ev, label) {
    const w = this.data.weapons[this.currentId];
    w.viewModel ||= {};
    w.viewModel.clips ||= {};
    const existed = !!w.viewModel.clips[ev];
    const clip = migrateToClip(w.viewModel.clips[ev]);
    if (!existed) clip.loop = ev === "idle" ? "loop" : "once";
    w.viewModel.clips[ev] = clip;
    this._renderAnimPage();
    this.animator.open(clip, { title: `${w.name || this.currentId} — ${label}`, onChange: () => {} });
  }

  _textRowVM(label, key, value) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "text", class: "ed-text", value,
        onchange: (e) => this._setVM(key, e.target.value.trim()) }),
    ]);
  }

  _numRowVM(label, key, value, min, max, step) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "number", class: "ed-num wide", min: String(min), max: String(max), step: String(step), value: String(value),
        onchange: (e) => this._setVM(key, parseFloat(e.target.value) || 0) }),
    ]);
  }

  _vec3RowVM(label, key, values, step) {
    const row = el("div", { class: "ed-prop-row" }, [el("label", { text: label })]);
    const grp = el("div", { class: "ed-num3" });
    const arr = values.slice();
    arr.forEach((v, i) => grp.appendChild(el("input", {
      type: "number", class: "ed-num", step: String(step), value: String(v),
      onchange: (e) => { arr[i] = parseFloat(e.target.value) || 0; this._setVM(key, arr.slice()); },
    })));
    row.appendChild(grp);
    return row;
  }

  _slotRow(slot) {
    const mk = (val, txt) => el("button", {
      class: "ed-btn sm" + (slot === val ? " primary" : ""), text: txt,
      onclick: () => { this._set("slot", val); this._renderFields(); this._renderList(); },
    });
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: "Emplacement" }),
      el("div", { class: "ed-row" }, [mk("primary", "Principal"), mk("secondary", "Secondaire")]),
    ]);
  }

  _addWeapon() {
    let n = 1;
    while (this.data.weapons["arme_" + n]) n++;
    const id = "arme_" + n;
    this.data.weapons[id] = {
      name: "Nouvelle arme", slot: "primary", unlock: 1,
      damage: 25, fireRate: 8, mag: 20, reload: 2, spread: 0.01,
      auto: true, range: 150, color: "#ffd27a", recoil: 0.02, recoilH: 0.5, shake: 0.06,
    };
    this.currentId = id;
    this._renderList(); this._renderFields();
    this.toast("Arme créée. Pensez à « Appliquer » / « Sauvegarder ».");
  }

  _deleteWeapon() {
    const ids = Object.keys(this.data.weapons);
    if (ids.length <= 1) { this.toast("Impossible : il faut au moins une arme."); return; }
    delete this.data.weapons[this.currentId];
    this.currentId = Object.keys(this.data.weapons)[0];
    this._renderList(); this._renderFields();
    this.toast("Arme supprimée (Appliquer / Sauvegarder pour confirmer).");
  }

  _set(key, value) { this.data.weapons[this.currentId][key] = value; }

  _numRow(label, key, value, min, max, step) {
    const slider = el("input", { type: "range", class: "we-slider", min: String(min), max: String(max), step: String(step), value: String(value) });
    const num = el("input", { type: "number", class: "ed-num wide", min: String(min), max: String(max), step: String(step), value: String(value) });
    const sync = (v) => { slider.value = String(v); num.value = String(v); this._set(key, v); };
    slider.addEventListener("input", () => sync(parseFloat(slider.value)));
    num.addEventListener("change", () => sync(parseFloat(num.value)));
    return el("div", { class: "ed-prop-row we-row" }, [el("label", { text: label }), slider, num]);
  }

  _optionalRow(label, key, min, max, step) {
    const btn = el("button", { class: "ed-btn sm", text: "+ activer",
      onclick: () => { this._set(key, key === "pellets" ? 1 : 1.5); this._renderFields(); } });
    return el("div", { class: "ed-prop-row" }, [el("label", { text: label }), btn]);
  }

  _textRow(label, key, value) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "text", class: "ed-text", value, maxlength: "24",
        onchange: (e) => { this._set(key, e.target.value); this._renderList(); } }),
    ]);
  }

  _colorRow(label, value) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "color", class: "ed-color", value,
        oninput: (e) => { this._set("color", e.target.value); this._renderList(); } }),
    ]);
  }

  _checkRow(label, key, checked) {
    const input = el("input", { type: "checkbox", onchange: (e) => this._set(key, e.target.checked) });
    if (checked) input.checked = true;
    return el("div", { class: "ed-prop-row" }, [el("label", { text: label }), input]);
  }

  _apply() {
    applyWeaponsData(this.data);
    this.toast("Stats appliquées — visibles à la prochaine partie solo.");
  }

  async _save() {
    this._apply();
    if (desktopWeapons) {
      const ok = await desktopWeapons.write(this.data);
      this.toast(ok
        ? "weapons.json sauvegardé. Redémarrez le serveur pour l'impact ONLINE."
        : "Écriture impossible (fichier en lecture seule dans un build packagé). Utilisez Exporter.");
    } else {
      this._export();
      this.toast("Téléchargé. Remplacez public/data/weapons.json puis redémarrez le serveur.");
    }
  }

  _export() {
    const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: "weapons.json" });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _import(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!json.weapons) throw new Error("format invalide");
      this.data = json;
      this.currentId = Object.keys(json.weapons)[0] || null;
      this._renderList(); this._renderFields();
      this.toast("Armes importées (pensez à Appliquer / Sauvegarder).");
    } catch (err) {
      this.toast("Import impossible : " + (err?.message || err));
    }
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove("hidden");
    clearTimeout(this._t);
    this._t = setTimeout(() => this.toastEl.classList.add("hidden"), 4200);
  }
}

// Viewport 3D d'inspection : montre l'arme, applique le clip en cours d'édition,
// glisser = tourner, molette = zoom, auto-rotation au repos.
class WeaponPreview {
  constructor(container, animator) {
    this.animator = animator;
    const head = el("div", { class: "ed-section-title", text: "APERÇU (glisser pour tourner)" });
    container.appendChild(head);
    this.canvas = el("canvas", { class: "we-preview" });
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(0, 0.05, 1.5);
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x40464f, 1.25));
    const d = new THREE.DirectionalLight(0xffffff, 1.5); d.position.set(1.5, 2, 1.5); this.scene.add(d);
    // L'arme vit dans un pivot (pour la faire tourner sans bouger la caméra).
    this.vm = new ViewModel(this.camera);
    this.camera.remove(this.vm.group);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.pivot.add(this.vm.group);

    this.yaw = -0.5; this.pitch = 0.1; this.dist = 1.5; this.auto = true;
    this._raf = 0; this._clock = new THREE.Clock();
    this._drag = null;
    this.canvas.addEventListener("pointerdown", (e) => { this._drag = { x: e.clientX, y: e.clientY }; this.auto = false; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this._drag) return;
      this.yaw += (e.clientX - this._drag.x) * 0.01;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + (e.clientY - this._drag.y) * 0.01));
      this._drag = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener("pointerup", () => { this._drag = null; });
    this.canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.dist = Math.max(0.6, Math.min(4, this.dist + e.deltaY * 0.002)); }, { passive: false });
  }
  setWeapon(id, tint) { this.vm.setWeapon(id, tint); }
  start() { if (this._raf) return; this._clock.getDelta(); const loop = () => { this._raf = requestAnimationFrame(loop); this._frame(); }; loop(); }
  stop() { cancelAnimationFrame(this._raf); this._raf = 0; }
  _resize() {
    const w = this.canvas.clientWidth || 300, h = this.canvas.clientHeight || 220;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
  }
  _frame() {
    this._resize();
    const dt = Math.min(this._clock.getDelta(), 0.05);
    if (this.auto) this.yaw += dt * 0.5;
    // caméra orbitale autour du pivot
    const cy = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cy * this.dist, Math.sin(this.pitch) * this.dist + 0.05, Math.cos(this.yaw) * cy * this.dist);
    this.camera.lookAt(0, 0, -0.25);
    // pose de repos centrée + clip en cours d'édition
    const g = this.vm.group;
    g.position.set(0, 0, -0.25); g.rotation.set(0, 0, 0); g.scale.setScalar(1);
    if (this.animator.isOpen && this.animator.clip) {
      const t = this.animator.tick(dt);
      const o = sampleAnim(this.animator.clip, t);
      g.position.set(o.p[0], o.p[1], -0.25 + o.p[2]);
      g.rotation.set(o.r[0], o.r[1], o.r[2]);
      g.scale.setScalar(o.s ?? 1);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/** Ouvre (ou ré-affiche) l'éditeur d'armes. Recharge les stats courantes à l'ouverture. */
export function openWeaponsEditor() {
  if (!_instance) _instance = new WeaponsEditor();
  else { _instance.data = serializeWeapons(); _instance.currentId = Object.keys(_instance.data.weapons)[0]; _instance._renderList(); _instance._renderFields(); }
  _instance.show();
}
