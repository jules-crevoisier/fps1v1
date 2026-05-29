// Panneau d'interface de l'éditeur de cartes (DOM construit dynamiquement).
// Barre d'outils, sélecteur de carte, liste d'objets, propriétés live, actions.

import { MAP_LIST, BUILTIN_MAP_IDS, getMap, registerMap } from "../arena.js";
import {
  listCustomMaps, loadCustomMap, saveCustomMap, deleteCustomMap,
  sanitizeId, exportMapToFile, importMapFromFile, isDesktopMaps, publishMapToGame,
} from "./mapStore.js";
import { blankMap } from "./editor.js";
import { openWeaponsEditor } from "./weaponsEditor.js";
import { steam, ACH } from "../steam.js";

const KIND_LABEL = { cover: "Bloc", spawn: "Spawn", pickup: "Soin", endpoint: "Extrémité" };

/** Petit helper de création d'élément. */
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

export class EditorUI {
  constructor(editor) {
    this.editor = editor;
    this.root = null;
    this._built = false;
  }

  show() {
    if (!this._built) this._build();
    this.root.classList.remove("hidden");
    this.refresh();
    this.showProperties(null);
  }

  hide() { if (this.root) this.root.classList.add("hidden"); }

  // ------------------------------------------------------------------ construction
  _build() {
    const ed = this.editor;
    const toolBtn = (label, title, on) => el("button", { class: "ed-btn", title, text: label, onclick: on });

    this.modeBtns = {
      translate: toolBtn("Déplacer", "Translation (G)", () => ed.setMode("translate")),
      rotate: toolBtn("Tourner", "Rotation (R)", () => ed.setMode("rotate")),
      scale: toolBtn("Redim.", "Échelle (T)", () => ed.setMode("scale")),
    };

    this.snapChk = el("input", { type: "checkbox", checked: "checked", onchange: (e) => ed.setSnap(e.target.checked) });
    this.gridInput = el("input", { type: "number", class: "ed-num", value: "1", min: "0.25", step: "0.25",
      onchange: (e) => ed.setGridStep(parseFloat(e.target.value)) });

    const toolbar = el("div", { class: "ed-toolbar" }, [
      el("div", { class: "ed-brand", html: "ARENA<span>ÉDITEUR</span>" }),
      el("div", { class: "ed-group" }, [
        toolBtn("+ Bloc", "Ajouter un bloc", () => ed.addCover()),
        toolBtn("+ Spawn", "Ajouter un point d'apparition", () => ed.addSpawn()),
        toolBtn("+ Soin", "Ajouter un pickup de soin", () => ed.addPickup()),
        toolBtn("+ TP", "Ajouter un téléporteur (2 extrémités)", () => ed.addTeleporter()),
        toolBtn("+ Tyro", "Ajouter une tyrolienne", () => ed.addZipline()),
        toolBtn("Dupliquer", "Dupliquer la sélection (Ctrl+D)", () => ed.duplicateSelected()),
        toolBtn("Supprimer", "Supprimer la sélection (Suppr)", () => ed.deleteSelected()),
      ]),
      el("div", { class: "ed-group" }, [this.modeBtns.translate, this.modeBtns.rotate, this.modeBtns.scale]),
      el("div", { class: "ed-group" }, [
        el("label", { class: "ed-inline" }, [this.snapChk, el("span", { text: "Grille" })]),
        this.gridInput,
      ]),
      el("div", { class: "ed-group" }, [
        toolBtn("Modèle .glb", "Importer un modèle 3D (prévisualisation)", () => this.modelInput.click()),
        toolBtn("Armes", "Éditeur d'armes", () => openWeaponsEditor()),
      ]),
    ]);

    // ---- panneau gauche : carte + liste d'objets ----
    this.mapSelect = el("select", { class: "ed-select" });
    this.objList = el("div", { class: "ed-list" });
    const left = el("div", { class: "ed-left" }, [
      el("div", { class: "ed-section-title", text: "CARTE" }),
      this.mapSelect,
      el("div", { class: "ed-row" }, [
        el("button", { class: "ed-btn sm", text: "Charger", onclick: () => this._loadSelected() }),
        el("button", { class: "ed-btn sm", text: "Vierge", onclick: () => this._loadBlank() }),
        el("button", { class: "ed-btn sm danger", text: "Suppr.", onclick: () => this._deleteSelected() }),
      ]),
      el("div", { class: "ed-section-title", text: "OBJETS" }),
      this.objList,
    ]);

    // ---- panneau droit : propriétés ----
    this.props = el("div", { class: "ed-props" });
    const right = el("div", { class: "ed-right" }, [
      el("div", { class: "ed-section-title", text: "PROPRIÉTÉS" }),
      this.props,
    ]);

    // ---- barre du bas : actions ----
    this.nameInput = el("input", { type: "text", class: "ed-text", maxlength: "32", placeholder: "Nom de la carte" });
    const bottom = el("div", { class: "ed-bottom" }, [
      el("label", { class: "ed-inline" }, [el("span", { text: "Nom" }), this.nameInput]),
      el("button", { class: "ed-btn", title: "Annuler (Ctrl+Z)", text: "↶ Annuler", onclick: () => this.editor.undo() }),
      el("button", { class: "ed-btn", title: "Rétablir (Ctrl+Y)", text: "↷ Rétablir", onclick: () => this.editor.redo() }),
      el("button", { class: "ed-btn primary", text: "▶ Tester (solo)", onclick: () => this._test() }),
      el("button", { class: "ed-btn", text: "💾 Sauvegarder", onclick: () => this._save() }),
      el("button", { class: "ed-btn primary", text: "🚀 Publier au jeu", title: "Ajoute la carte à public/data/maps (jouable en ligne après redémarrage du serveur)", onclick: () => this._publish() }),
      el("button", { class: "ed-btn", text: "Exporter JSON", onclick: () => this._export() }),
      el("button", { class: "ed-btn", text: "Importer JSON", onclick: () => this.importInput.click() }),
      el("button", { class: "ed-btn ghost", text: "Quitter", onclick: () => this.editor.hooks.onExit() }),
    ]);

    // inputs fichiers cachés
    this.importInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none",
      onchange: (e) => this._importFile(e) });
    this.modelInput = el("input", { type: "file", accept: ".glb,.gltf", style: "display:none",
      onchange: (e) => this._importModel(e) });

    this.toastEl = el("div", { class: "ed-toast hidden" });
    this.hint = el("div", { class: "ed-hint", text: "Clic : sélectionner · Glisser : orbite · G/R/T : déplacer/tourner/redim. · Suppr : supprimer" });

    this.root = el("div", { class: "ed-root hidden" }, [
      toolbar, left, right, bottom, this.hint, this.toastEl, this.importInput, this.modelInput,
    ]);
    document.body.appendChild(this.root);
    this._built = true;
    this.setModeButton("translate");
  }

  // ------------------------------------------------------------------ rafraîchissements
  async refresh() {
    if (!this._built) return;
    this.nameInput.value = this.editor.map.name || "";
    await this._populateMapSelect();
    this._renderObjList();
    // Resynchronise le panneau de propriétés (sinon les boutons d'outils/sections
    // n'apparaissent pas après l'activation d'une option comme « Relief »).
    this.showProperties(this.editor.selected || null);
  }

  async _populateMapSelect() {
    const builtins = MAP_LIST.filter((m) => BUILTIN_MAP_IDS.has(m.id));
    const customs = await listCustomMaps();
    this.mapSelect.innerHTML = "";
    const addOpt = (id, label) => this.mapSelect.appendChild(el("option", { value: id, text: label }));
    if (builtins.length) {
      const g = el("optgroup", { label: "Intégrées" });
      builtins.forEach((m) => g.appendChild(el("option", { value: m.id, text: m.name })));
      this.mapSelect.appendChild(g);
    }
    if (customs.length) {
      const g = el("optgroup", { label: isDesktopMaps ? "Personnalisées (fichier)" : "Personnalisées (navigateur)" });
      customs.forEach((m) => g.appendChild(el("option", { value: "custom:" + m.id, text: m.name })));
      this.mapSelect.appendChild(g);
    }
    if (this.editor.map.id) this.mapSelect.value = this._isCustom(this.editor.map.id) ? "custom:" + this.editor.map.id : this.editor.map.id;
  }

  _isCustom(id) { return !BUILTIN_MAP_IDS.has(id); }

  _renderObjList() {
    this.objList.innerHTML = "";
    this._collapsed = this._collapsed || {}; // état de repli par groupe (persistant en session)
    const groups = { cover: [], spawn: [], pickup: [], endpoint: [] };
    this.editor.objects.forEach((o, i) => { (groups[o.kind] || (groups[o.kind] = [])).push({ o, i }); });

    const nameOf = (o) => o.kind === "cover" ? `${o.data.accent ? "★ " : ""}Bloc` :
      o.kind === "spawn" ? `Spawn ${o.index + 1}` :
      o.kind === "endpoint" ? `${o.ref.type === "tp" ? "TP" : "Tyro"} ${o.ref.index + 1} · ${o.ref.key}` :
      `Soin (${o.data.healAmount || 35})`;

    for (const kind of ["cover", "spawn", "pickup", "endpoint"]) {
      const list = groups[kind];
      if (!list || !list.length) continue;
      const open = !this._collapsed[kind];
      const header = el("div", {
        class: "ed-group-head",
        text: `${open ? "▾" : "▸"} ${KIND_LABEL[kind]} (${list.length})`,
        onclick: () => { this._collapsed[kind] = open; this._renderObjList(); },
      });
      this.objList.appendChild(header);
      if (!open) continue;
      for (const { o, i } of list) {
        const item = el("div", {
          class: "ed-list-item" + (this.editor.selected === o ? " active" : ""),
          text: nameOf(o),
          onclick: () => this.editor.selectByListIndex(i),
        });
        item._editObj = o;
        this.objList.appendChild(item);
      }
    }
  }

  // Section animation d'un cover (plateforme mobile / porte / rotation).
  // anim = { mode:"loop"|"pingpong", dur, dp:[3] (offset position), dr:[3] (offset rotation rad) }
  _animSection(obj) {
    const p = this.props, ed = this.editor;
    p.appendChild(el("div", { class: "ed-prop-head", text: "Animation" }));
    const a = obj.data.anim;
    if (!a) {
      p.appendChild(el("button", { class: "ed-btn sm primary", text: "+ Animer cet objet",
        onclick: () => ed.openAnimator(obj) }));
      p.appendChild(el("div", { class: "ed-prop-note", text: "Ouvre l'animateur (timeline + keyframes : position, rotation, échelle)." }));
      return;
    }
    p.appendChild(el("div", { class: "ed-row" }, [
      el("button", { class: "ed-btn sm primary", text: "🎬 Ouvrir l'animateur", onclick: () => ed.openAnimator(obj) }),
      el("button", { class: "ed-btn sm danger", text: "Retirer", onclick: () => ed.removeAnimation(obj) }),
    ]));
    p.appendChild(el("div", { class: "ed-prop-note", text: `${a.keys?.length || 0} keyframe(s) · ${a.loop || "pingpong"} · ${a.dur || 2}s` }));
  }

  highlightList(obj) {
    if (!this._built) return;
    for (const it of this.objList.children) it.classList.toggle("active", it._editObj === obj);
  }

  setModeButton(mode) {
    if (!this.modeBtns) return;
    for (const [k, b] of Object.entries(this.modeBtns)) b.classList.toggle("active", k === mode);
  }

  // ------------------------------------------------------------------ propriétés
  showProperties(obj) {
    if (!this._built) return;
    this.props.innerHTML = "";
    if (!obj) { this._renderMapProps(); return; }
    const p = this.props;
    const head = obj.kind === "endpoint"
      ? (obj.ref.type === "tp" ? "Téléporteur" : "Tyrolienne") + " · " + obj.ref.key
      : KIND_LABEL[obj.kind];
    p.appendChild(el("div", { class: "ed-prop-head", text: head }));
    let pos;
    if (obj.kind === "spawn") pos = this.editor.map.spawns[obj.index];
    else if (obj.kind === "endpoint") pos = this.editor._pairArr(obj.ref.type)[obj.ref.index][obj.ref.key];
    else pos = obj.data.pos;
    p.appendChild(this._num3("Position", ["px", "py", "pz"], pos));
    if (obj.kind === "endpoint") {
      p.appendChild(el("div", { class: "ed-prop-note",
        text: obj.ref.type === "tp"
          ? "Téléporteur bidirectionnel (les 2 extrémités). Supprimer = retire la paire."
          : "Tyrolienne : on s'accroche en visant ; direction = le regard. Supprimer = retire la paire." }));
    }
    if (obj.kind === "cover") {
      p.appendChild(this._num3("Taille (L/H/P)", ["w", "h", "d"], obj.data.size));
      const r = Array.isArray(obj.data.rot) ? obj.data.rot : [0, obj.data.rot || 0, 0];
      p.appendChild(this._num3("Rotation (° X/Y/Z)", ["rotX", "rotY", "rotZ"],
        [r[0] * 180 / Math.PI, r[1] * 180 / Math.PI, r[2] * 180 / Math.PI]));
      p.appendChild(this._check("Accent (ambre)", "accent", !!obj.data.accent));
      this._animSection(obj);
    } else if (obj.kind === "pickup") {
      p.appendChild(this._num("Soin (PV)", "healAmount", obj.data.healAmount || 35, 5));
      p.appendChild(el("div", { class: "ed-prop-note", text: "id : " + (obj.data.id || "") }));
    }
    p.appendChild(el("div", { class: "ed-row", style: "margin-top:8px" }, [
      el("button", { class: "ed-btn sm", text: "Dupliquer", onclick: () => this.editor.duplicateSelected() }),
      el("button", { class: "ed-btn sm danger", text: "Supprimer", onclick: () => this.editor.deleteSelected() }),
    ]));
  }

  _renderMapProps() {
    const ed = this.editor, m = ed.map, p = this.props;
    p.appendChild(el("div", { class: "ed-prop-head", text: "Réglages de la carte" }));
    p.appendChild(this._text("Nom", "name", m.name || ""));
    p.appendChild(this._num("Taille d'arène", "size", m.size || 60, 2));
    p.appendChild(this._color("Sol", "floorColor", m.floorColor));
    p.appendChild(this._color("Fond", "background", m.background));
    p.appendChild(this._color("Murs", "wallColor", m.wallColor));
    p.appendChild(this._color("Blocs", "coverColor", m.coverColor));
    p.appendChild(this._color("Accent", "accentColor", m.accentColor));
    const fog = m.fog || { near: 70, far: 190 };
    p.appendChild(this._num("Brouillard — début", "fogNear", fog.near ?? 70, 5));
    p.appendChild(this._num("Brouillard — fin", "fogFar", fog.far ?? 190, 5));
    // Mur de bordure (invisible + hauteur infinie ; décocher = arène ouverte)
    p.appendChild(this._check("Murs de bordure (invisibles)", "borderWalls", m.borderWalls !== false));

    // Terrain / relief (optionnel)
    p.appendChild(this._check("Relief (terrain)", "terrainOn", !!m.terrain));
    if (m.terrain) {
      p.appendChild(this._toolBtn("🖌 Sculpter", "sculpt"));
      if (ed.tool === "sculpt") {
        p.appendChild(this._segBtns("Mode", [["raise", "Élever"], ["flatten", "Aplanir"], ["smooth", "Lisser"]],
          ed.brushMode, (v) => { ed.brushMode = v; this.showProperties(null); }));
        p.appendChild(this._num("Pinceau — rayon", "brushRadius", ed.brushRadius, 1));
        p.appendChild(this._num("Pinceau — force", "brushStrength", ed.brushStrength, 0.1));
        p.appendChild(el("div", { class: "ed-prop-note",
          text: "Clic-glisser : appliquer · Alt/Maj : inverser (creuser) · clic DROIT : orbite." }));
      }
    }

    // Eau (optionnelle — lac/plan d'eau global)
    p.appendChild(this._check("Eau", "waterOn", !!m.water));
    if (m.water) {
      p.appendChild(this._num("Niveau d'eau (Y)", "waterLevel", m.water.level ?? 0.5, 0.25));
      p.appendChild(this._color("Couleur eau", "waterColor", m.water.color || "#2e6f8e"));
      p.appendChild(this._num("Opacité eau", "waterOpacity", m.water.opacity ?? 0.6, 0.05));
    }
    p.appendChild(el("div", { class: "ed-prop-note",
      text: "Astuce : désélectionnez (Échap / clic dans le vide) pour revoir ces réglages globaux." }));
  }

  // Bouton bascule d'outil (actif/inactif).
  _toolBtn(label, tool) {
    const active = this.editor.tool === tool;
    return el("button", {
      class: "ed-btn sm" + (active ? " primary" : ""),
      text: active ? "✓ " + label : label,
      onclick: () => this.editor.setTool(active ? "select" : tool),
    });
  }

  // Groupe de boutons exclusifs (segmented control).
  _segBtns(label, options, current, onPick) {
    const row = el("div", { class: "ed-row" }, [el("span", { class: "ed-prop-note", text: label })]);
    options.forEach(([val, txt]) => row.appendChild(el("button", {
      class: "ed-btn sm" + (current === val ? " primary" : ""), text: txt, onclick: () => onPick(val),
    })));
    return row;
  }

  _num3(label, fields, values) {
    const row = el("div", { class: "ed-prop-row" }, [el("label", { text: label })]);
    const grp = el("div", { class: "ed-num3" });
    fields.forEach((f, i) => {
      grp.appendChild(el("input", {
        type: "number", class: "ed-num", step: "0.5", value: String(round(values[i])),
        onchange: (e) => this.editor.updateProp(f, parseFloat(e.target.value) || 0),
      }));
    });
    row.appendChild(grp);
    return row;
  }

  _num(label, field, value, step = 1) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", {
        type: "number", class: "ed-num wide", step: String(step), value: String(round(value)),
        onchange: (e) => this.editor.updateProp(field, parseFloat(e.target.value) || 0),
      }),
    ]);
  }

  _text(label, field, value) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "text", class: "ed-text", value, maxlength: "32",
        onchange: (e) => this.editor.updateProp(field, e.target.value) }),
    ]);
  }

  _color(label, field, value) {
    return el("div", { class: "ed-prop-row" }, [
      el("label", { text: label }),
      el("input", { type: "color", class: "ed-color", value: value || "#000000",
        oninput: (e) => this.editor.updateProp(field, e.target.value) }),
    ]);
  }

  _check(label, field, checked) {
    const input = el("input", { type: "checkbox", onchange: (e) => this.editor.updateProp(field, e.target.checked) });
    if (checked) input.checked = true;
    return el("div", { class: "ed-prop-row" }, [el("label", { text: label }), input]);
  }

  // ------------------------------------------------------------------ actions
  async _loadSelected() {
    const val = this.mapSelect.value;
    if (!val) return;
    if (val.startsWith("custom:")) {
      const map = await loadCustomMap(val.slice(7));
      if (map) this.editor.loadMap(map);
      else this.toast("Carte introuvable.");
    } else {
      const map = getMap(val);
      if (map) this.editor.loadMap(map);
    }
  }

  _loadBlank() { this.editor.loadMap(blankMap()); }

  async _deleteSelected() {
    const val = this.mapSelect.value;
    if (!val || !val.startsWith("custom:")) { this.toast("Seules les cartes personnalisées sont supprimables."); return; }
    const id = val.slice(7);
    await deleteCustomMap(id);
    this.toast("Carte supprimée.");
    this.refresh();
  }

  _test() {
    const name = (this.nameInput.value || "").trim() || "Carte de test";
    const map = this.editor.getMap("__editor_test", name);
    this.editor.hooks.onTest(map);
  }

  async _save() {
    const name = (this.nameInput.value || "").trim() || "Carte sans nom";
    const id = sanitizeId(name);
    if (BUILTIN_MAP_IDS.has(id)) { this.toast("Ce nom entre en conflit avec une carte intégrée. Choisissez-en un autre."); return; }
    const map = this.editor.getMap(id, name);
    const saved = await saveCustomMap(map);
    if (!saved) { this.toast("Échec de la sauvegarde."); return; }
    steam.unlock(ACH.EDITOR_SAVE);    // succès : créer/sauvegarder une carte (no-op hors Steam)
    registerMap(map);                 // rendue jouable + listée dans le menu
    this.editor.map.id = id;
    this.refresh();
    this.toast(`Carte « ${name} » sauvegardée et ajoutée au menu.`);
  }

  async _publish() {
    const name = (this.nameInput.value || "").trim() || "Carte sans nom";
    const id = sanitizeId(name);
    if (BUILTIN_MAP_IDS.has(id)) { this.toast("Ce nom entre en conflit avec une carte intégrée. Choisissez-en un autre."); return; }
    const map = this.editor.getMap(id, name);
    const res = await publishMapToGame(map);
    if (!res) { this.toast("Publication impossible."); return; }
    registerMap(map);                 // jouable + listée dans le menu tout de suite (solo)
    this.editor.map.id = id;
    this.refresh();
    if (res === "published") {
      this.toast(`Carte « ${name} » publiée dans le jeu. Redémarrez le serveur pour le mode EN LIGNE.`);
    } else {
      this.toast(`Carte exportée (${id}.json). Déposez-la dans public/data/maps/ puis redémarrez le serveur.`);
    }
  }

  _export() {
    const name = (this.nameInput.value || "").trim() || "carte";
    exportMapToFile(this.editor.getMap(sanitizeId(name), name));
  }

  async _importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const map = await importMapFromFile(file);
      if (!map || typeof map !== "object") throw new Error("format invalide");
      this.editor.loadMap(map);
      this.toast("Carte importée.");
    } catch (err) {
      this.toast("Import impossible : " + (err?.message || err));
    }
  }

  async _importModel(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await this.editor.importModelFile(file);
  }

  toast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove("hidden");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.add("hidden"), 3800);
  }
}

function round(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
