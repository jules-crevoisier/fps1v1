// Fenêtre d'animation type After Effects : timeline, keyframes (keypoints),
// transport (lecture/pause/scrub), options par clé (position, rotation, échelle, ease).
//
// Composant DÉCOUPLÉ du rendu : il édite un objet `clip` (format anim.js) et expose
// `time` + `playing`. L'hôte (éditeur de cartes / d'armes) appelle `tick(dt)` chaque
// frame puis applique `sampleAnim(clip, time)` à l'objet 3D cible.

import { makeClip } from "../anim.js";

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

const R2D = 180 / Math.PI, D2R = Math.PI / 180;

export class Animator {
  constructor() {
    this.clip = null;
    this.time = 0;
    this.playing = false;
    this.selIndex = 0;
    this.onChange = null;
    this.onClose = null;
    this._build();
  }

  _build() {
    this.timeLabel = el("span", { class: "an-time", text: "0.00s" });
    this.playBtn = el("button", { class: "ed-btn sm", text: "▶", onclick: () => this.togglePlay() });
    this.durInput = el("input", { type: "number", class: "ed-num", step: "0.1", min: "0.1", value: "2",
      onchange: (e) => { this.clip.dur = Math.max(0.1, parseFloat(e.target.value) || 1); this._clampKeys(); this._changed(); this._render(); } });
    this.loopSel = el("select", { class: "an-sel", onchange: (e) => { this.clip.loop = e.target.value; this._changed(); } }, [
      el("option", { value: "pingpong", text: "Aller-retour" }),
      el("option", { value: "loop", text: "Boucle" }),
      el("option", { value: "once", text: "Une fois" }),
    ]);

    this.track = el("div", { class: "an-track", onclick: (e) => this._trackClick(e) });
    this.playhead = el("div", { class: "an-playhead" });
    this.track.appendChild(this.playhead);
    this.dots = el("div", { class: "an-dots" });
    this.track.appendChild(this.dots);

    this.keyEditor = el("div", { class: "an-keyed" });

    const transport = el("div", { class: "an-row" }, [
      el("button", { class: "ed-btn sm", title: "Début", text: "⏮", onclick: () => { this.time = 0; this._render(); } }),
      this.playBtn, this.timeLabel,
      el("label", { class: "an-inline" }, [el("span", { text: "Durée" }), this.durInput]),
      el("label", { class: "an-inline" }, [el("span", { text: "Boucle" }), this.loopSel]),
    ]);
    const keyBtns = el("div", { class: "an-row" }, [
      el("button", { class: "ed-btn sm primary", text: "+ Clé ici", onclick: () => this.addKeyAtPlayhead() }),
      el("button", { class: "ed-btn sm danger", text: "Suppr clé", onclick: () => this.deleteSelected() }),
    ]);

    this.root = el("div", { class: "an-root hidden" }, [
      el("div", { class: "an-head" }, [
        el("span", { class: "an-title", text: "ANIMATEUR" }),
        el("button", { class: "ed-btn sm ghost", text: "✕", onclick: () => this.close() }),
      ]),
      transport,
      el("div", { class: "an-tracklabel", text: "Timeline (clic = déplacer la tête · clic sur une clé = la sélectionner)" }),
      this.track,
      keyBtns,
      this.keyEditor,
    ]);
    document.body.appendChild(this.root);
  }

  open(clip, { title, onChange, onClose } = {}) {
    this.clip = clip && Array.isArray(clip.keys) ? clip : makeClip();
    this.onChange = onChange || null;
    this.onClose = onClose || null;
    this.time = 0;
    this.playing = false;
    this.selIndex = 0;
    this.root.querySelector(".an-title").textContent = "ANIMATEUR — " + (title || "");
    this.durInput.value = String(this.clip.dur);
    this.loopSel.value = this.clip.loop || "pingpong";
    this.root.classList.remove("hidden");
    this._render();
  }

  close() {
    this.playing = false;
    this.root.classList.add("hidden");
    if (this.onClose) this.onClose();
    this.clip = null;
  }

  get isOpen() { return this.clip && !this.root.classList.contains("hidden"); }

  togglePlay() { this.playing = !this.playing; this.playBtn.textContent = this.playing ? "⏸" : "▶"; }

  tick(dt) {
    if (this.playing && this.clip) {
      this.time += dt;
      const dur = this.clip.dur || 1;
      if (this.clip.loop === "once" && this.time > dur) { this.time = dur; this.playing = false; this.playBtn.textContent = "▶"; }
      this._render(true); // léger : ne reconstruit pas l'éditeur de clé
    }
    return this.time;
  }

  _clampKeys() {
    const dur = this.clip.dur || 1;
    for (const k of this.clip.keys) k.t = Math.max(0, Math.min(dur, k.t));
    this.clip.keys.sort((a, b) => a.t - b.t);
  }

  _changed() { if (this.onChange) this.onChange(this.clip); }

  addKeyAtPlayhead() {
    // capture la valeur interpolée courante pour éviter un saut
    const v = this._sampleLocal(this.time);
    const k = { t: +this.time.toFixed(3), p: v.p.slice(), r: v.r.slice(), s: v.s, ease: "smooth" };
    // remplace une clé au même temps, sinon insère
    const i = this.clip.keys.findIndex((kk) => Math.abs(kk.t - k.t) < 1e-3);
    if (i >= 0) this.clip.keys[i] = k; else this.clip.keys.push(k);
    this._clampKeys();
    this.selIndex = this.clip.keys.indexOf(k);
    this._changed(); this._render();
  }

  deleteSelected() {
    if (this.clip.keys.length <= 1) return;
    this.clip.keys.splice(this.selIndex, 1);
    this.selIndex = Math.max(0, this.selIndex - 1);
    this._changed(); this._render();
  }

  // échantillonnage local (sans bouclage) pour la capture de keyframe
  _sampleLocal(t) {
    const keys = this.clip.keys;
    if (t <= keys[0].t) return kv(keys[0]);
    const last = keys[keys.length - 1];
    if (t >= last.t) return kv(last);
    let i = 0; while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const f = (t - k0.t) / ((k1.t - k0.t) || 1e-6);
    const a = kv(k0), b = kv(k1);
    return { p: a.p.map((v, j) => v + (b.p[j] - v) * f), r: a.r.map((v, j) => v + (b.r[j] - v) * f), s: a.s + (b.s - a.s) * f };
  }

  _trackClick(e) {
    if (e.target.classList.contains("an-dot")) return; // géré par le dot
    const rect = this.track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.time = f * (this.clip.dur || 1);
    this._render();
  }

  _render(light = false) {
    if (!this.clip) return;
    const dur = this.clip.dur || 1;
    this.timeLabel.textContent = this.time.toFixed(2) + "s";
    this.playhead.style.left = (100 * this.time / dur) + "%";
    if (light) return;
    // dots
    this.dots.innerHTML = "";
    this.clip.keys.forEach((k, i) => {
      const dot = el("div", { class: "an-dot" + (i === this.selIndex ? " sel" : ""), title: k.t.toFixed(2) + "s",
        onclick: (ev) => { ev.stopPropagation(); this.selIndex = i; this.time = k.t; this._render(); } });
      dot.style.left = (100 * k.t / dur) + "%";
      this.dots.appendChild(dot);
    });
    this._renderKeyEditor();
  }

  _renderKeyEditor() {
    const ke = this.keyEditor;
    ke.innerHTML = "";
    const k = this.clip.keys[this.selIndex];
    if (!k) return;
    ke.appendChild(el("div", { class: "an-keytitle", text: `Clé ${this.selIndex + 1} / ${this.clip.keys.length}` }));
    ke.appendChild(this._num("Temps (s)", k.t, 0.05, (v) => { k.t = v; this._clampKeys(); this.selIndex = this.clip.keys.indexOf(k); this.time = k.t; }));
    ke.appendChild(this._vec3("Position (X/Y/Z)", k.p, 0.25, (a) => { k.p = a; }));
    ke.appendChild(this._vec3("Rotation (° X/Y/Z)", k.r.map((r) => Math.round(r * R2D)), 15, (a) => { k.r = a.map((d) => d * D2R); }));
    ke.appendChild(this._num("Échelle", k.s ?? 1, 0.05, (v) => { k.s = Math.max(0.01, v); }));
    ke.appendChild(this._sel("Lissage", ["linear", "smooth"], k.ease || "smooth", (v) => { k.ease = v; }));
  }

  _num(label, value, step, set) {
    return el("div", { class: "an-prop" }, [
      el("label", { text: label }),
      el("input", { type: "number", class: "ed-num wide", step: String(step), value: String(value),
        onchange: (e) => { set(parseFloat(e.target.value) || 0); this._changed(); this._render(); } }),
    ]);
  }

  _vec3(label, values, step, set) {
    const grp = el("div", { class: "ed-num3" });
    const arr = values.slice();
    arr.forEach((v, i) => grp.appendChild(el("input", {
      type: "number", class: "ed-num", step: String(step), value: String(v),
      onchange: (e) => { arr[i] = parseFloat(e.target.value) || 0; set(arr.slice()); this._changed(); this._render(true); },
    })));
    return el("div", { class: "an-prop" }, [el("label", { text: label }), grp]);
  }

  _sel(label, opts, cur, set) {
    const s = el("select", { class: "an-sel", onchange: (e) => { set(e.target.value); this._changed(); } },
      opts.map((o) => el("option", { value: o, text: o })));
    s.value = cur;
    return el("div", { class: "an-prop" }, [el("label", { text: label }), s]);
  }
}

function kv(k) { return { p: (k.p || [0, 0, 0]).slice(), r: (k.r || [0, 0, 0]).slice(), s: typeof k.s === "number" ? k.s : 1 }; }
