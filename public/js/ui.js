// Couche UI : HUD, hub/lobby, loadout, stats, chat, killfeed.
import { WEAPONS, SKINS, PROFILE, RARITY_COLORS, skinOf, skinUnlocked, saveProfile, levelFromXp,
  weaponUnlocked, weaponLevel, weaponXpOf, xpForLevel } from "./config.js";

const hex = (n) => "#" + n.toString(16).padStart(6, "0");

export class UI {
  constructor() {
    this.el = {
      menu: document.getElementById("menu"),
      waiting: document.getElementById("waiting"),
      hud: document.getElementById("hud"),
      endscreen: document.getElementById("endscreen"),
      classes: document.getElementById("classes"),
      pseudo: document.getElementById("pseudo"),
      healthFill: document.getElementById("health-fill"),
      healthText: document.getElementById("health-text"),
      className: document.getElementById("class-name"),
      ammoCur: document.getElementById("ammo-cur"),
      ammoMax: document.getElementById("ammo-max"),
      weaponName: document.getElementById("weapon-name"),
      reloading: document.getElementById("reloading"),
      scoreMe: document.getElementById("score-me"),
      scoreOpp: document.getElementById("score-opp"),
      killfeed: document.getElementById("killfeed"),
      hitmarker: document.getElementById("hitmarker"),
      stateTag: document.getElementById("state-tag"),
      chatLog: document.getElementById("chat-log"),
      chatInput: document.getElementById("chat-input"),
      endTitle: document.getElementById("end-title"),
      endScore: document.getElementById("end-score"),
      pause: document.getElementById("pause"),
      scope: document.getElementById("scope"),
      crosshair: document.getElementById("crosshair"),
      dmgFlash: document.getElementById("dmg-flash"),
      fps: document.getElementById("fps"),
    };
    this._scoped = false;
  }

  // Compteur FPS optionnel.
  showFps(on) { this.el.fps.classList.toggle("hidden", !on); }
  setFps(v) { this.el.fps.textContent = `${v} FPS`; }

  flashDamage() {
    const f = this.el.dmgFlash;
    f.classList.remove("hit"); void f.offsetWidth; f.classList.add("hit");
  }

  setScope(on) {
    if (on === this._scoped) return;
    this._scoped = on;
    this.el.scope.classList.toggle("hidden", !on);
    this.el.crosshair.style.visibility = on ? "hidden" : "visible";
  }

  show(screen) {
    ["menu", "waiting", "hud", "endscreen", "pause"].forEach((k) => this.el[k].classList.add("hidden"));
    if (screen) this.el[screen].classList.remove("hidden");
  }
  showHud() { this.el.hud.classList.remove("hidden"); }

  buildClassCards(classes, current, onSelect) {
    this.el.classes.innerHTML = "";
    Object.entries(classes).forEach(([id, c]) => {
      const card = document.createElement("div");
      card.className = "class-card" + (id === current ? " selected" : "");
      card.dataset.id = id;
      card.innerHTML = `<div class="icon">${c.iconSvg || ""}</div><div class="cname">${c.name}</div><div class="cdesc">${c.desc}</div>`;
      card.onclick = () => {
        [...this.el.classes.children].forEach((x) => x.classList.remove("selected"));
        card.classList.add("selected");
        onSelect(id);
      };
      this.el.classes.appendChild(card);
    });
  }

  // ---- Sélecteur en pilules (mode / carte) ----
  buildPills(containerId, items, current, onSelect) {
    const c = document.getElementById(containerId);
    c.innerHTML = items.map((it) =>
      `<div class="pill${it.id === current ? " active" : ""}" data-id="${it.id}"><div class="pname">${it.name}</div>${it.desc ? `<div class="pdesc">${it.desc}</div>` : ""}</div>`
    ).join("");
    c.querySelectorAll(".pill").forEach((p) => p.onclick = () => {
      c.querySelectorAll(".pill").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      onSelect(p.dataset.id);
    });
  }

  // ---- Onglets du hub ----
  setupTabs() {
    const tabs = [...document.querySelectorAll(".tab")];
    tabs.forEach((t) => t.onclick = () => {
      tabs.forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".tabpane").forEach((p) =>
        p.classList.toggle("hidden", p.dataset.pane !== t.dataset.tab));
    });
  }

  _wbar(label, val, max) {
    return `<div class="wstat"><div class="wlabel">${label}</div><div class="wbar"><i style="width:${Math.min(100, val / max * 100)}%"></i></div></div>`;
  }
  _wcard(id, selected) {
    const w = WEAPONS[id];
    const locked = !weaponUnlocked(id);
    const lvl = weaponLevel(id);
    return `<div class="weapon-card${selected ? " selected" : ""}${locked ? " locked" : ""}" data-w="${id}">
      <div class="wcard-top"><span class="wname">${w.name}</span>${locked ? `<span class="wlock">🔒 Niv.${w.unlock}</span>` : `<span class="wmastery">MAÎTRISE ${lvl}</span>`}</div>
      <div class="wstats">
        ${this._wbar("DGT", w.damage * (w.pellets || 1), 100)}
        ${this._wbar("CAD", w.fireRate, 16)}
        ${this._wbar("PORT", w.range, 400)}
      </div></div>`;
  }

  // ---- Loadout (armes + skins + résumé) ----
  renderLoadout(onChange) {
    this._skinTarget = this._skinTarget || PROFILE.loadout.primary;
    const prim = document.getElementById("loadout-primary");
    const sec = document.getElementById("loadout-secondary");
    const ids = Object.keys(WEAPONS);
    prim.innerHTML = ids.filter((k) => WEAPONS[k].slot === "primary").map((k) => this._wcard(k, PROFILE.loadout.primary === k)).join("");
    sec.innerHTML = ids.filter((k) => WEAPONS[k].slot === "secondary").map((k) => this._wcard(k, PROFILE.loadout.secondary === k)).join("");
    const wire = (grid, slot) => grid.querySelectorAll(".weapon-card:not(.locked)").forEach((c) => c.onclick = () => {
      PROFILE.loadout[slot] = c.dataset.w; this._skinTarget = c.dataset.w; saveProfile();
      this.renderLoadout(onChange); onChange && onChange();
    });
    // cliquer une arme verrouillée la sélectionne juste pour voir ses skins
    [...prim.querySelectorAll(".weapon-card.locked"), ...sec.querySelectorAll(".weapon-card.locked")]
      .forEach((c) => c.onclick = () => { this._skinTarget = c.dataset.w; this._renderSkins(); });
    wire(prim, "primary"); wire(sec, "secondary");
    this._renderSkins();
    this.renderSummary();
  }
  _renderSkins() {
    const id = this._skinTarget;
    const lvl = weaponLevel(id), xp = weaponXpOf(id);
    const cur = xpForLevel(lvl), next = xpForLevel(lvl + 1);
    const pct = Math.min(100, (xp - cur) / (next - cur) * 100);
    document.getElementById("skin-title").innerHTML =
      `Skin — ${WEAPONS[id].name} · <span style="color:var(--accent)">Maîtrise ${lvl}</span> ` +
      `<span style="color:var(--muted2)">(${xp} XP)</span>` +
      `<span class="mastery-bar"><i style="width:${pct}%"></i></span>`;
    const row = document.getElementById("loadout-skins");
    row.innerHTML = Object.keys(SKINS).map((sid) => {
      const s = SKINS[sid], sel = skinOf(id) === sid, locked = !skinUnlocked(sid, id);
      const col = s.tint != null ? hex(s.tint) : "#3a3f4a";
      const label = locked ? `🔒 Maît.${s.unlock}` : s.name;
      return `<div class="skin-swatch${sel ? " selected" : ""}${locked ? " locked" : ""}" data-s="${sid}"><div class="dot" style="background:${col}"></div><div class="sk-name" style="color:${locked ? "#5d636d" : RARITY_COLORS[s.rarity]}">${label}</div></div>`;
    }).join("");
    row.querySelectorAll(".skin-swatch:not(.locked)").forEach((sw) => sw.onclick = () => {
      PROFILE.skins[id] = sw.dataset.s; saveProfile(); this._renderSkins(); this.renderSummary();
    });
  }
  renderSummary() {
    const lo = PROFILE.loadout;
    document.getElementById("loadout-summary").innerHTML = [["PRINCIPALE", lo.primary], ["SECONDAIRE", lo.secondary]].map(([slot, id]) => {
      const sk = SKINS[skinOf(id)];
      return `<div class="lo-item"><div class="lo-slot">${slot}</div><div class="lo-name">${WEAPONS[id].name}</div><div class="lo-skin" style="color:${RARITY_COLORS[sk.rarity]}">${sk.name}</div></div>`;
    }).join("");
  }

  // ---- Stats / progression ----
  renderStats() {
    const s = PROFILE.stats;
    const kd = (s.deaths ? s.kills / s.deaths : s.kills).toFixed(2);
    const wr = s.games ? Math.round(s.wins / s.games * 100) : 0;
    document.getElementById("stats-grid").innerHTML = [
      ["Parties", s.games], ["Victoires", s.wins], ["Taux victoire", wr + "%"],
      ["Kills", s.kills], ["Morts", s.deaths], ["K/D", kd],
    ].map(([l, v]) => `<div class="stat-box"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join("");
    const lvl = levelFromXp(PROFILE.xp);
    const base = (lvl - 1) * (lvl - 1) * 100, next = lvl * lvl * 100;
    document.getElementById("xp-label").textContent = "Niveau " + lvl + " — " + PROFILE.xp + " XP";
    document.getElementById("xp-fill").style.width = Math.min(100, (PROFILE.xp - base) / (next - base) * 100) + "%";
    document.getElementById("hub-level").textContent = "LV." + lvl;
  }

  setHealth(hp, max) {
    const f = Math.max(0, hp / max);
    this.el.healthFill.style.width = (f * 100) + "%";
    this.el.healthFill.style.background = f > 0.5 ? "#4cc46a" : f > 0.25 ? "#ff9e2c" : "#e8433f";
    this.el.healthText.textContent = Math.ceil(hp);
  }
  setAmmo(cur, max) { this.el.ammoCur.textContent = cur; this.el.ammoMax.textContent = max; }
  setWeapon(name) { this.el.weaponName.textContent = name; }
  setClassName(name) { this.el.className.textContent = name; }
  setReloading(on) { this.el.reloading.classList.toggle("hidden", !on); }
  setScore(me, opp) { this.el.scoreMe.textContent = me; this.el.scoreOpp.textContent = opp; }

  damageNumber(x, y, amount, headshot) {
    const e = document.createElement("div");
    e.className = "dmg-num" + (headshot ? " head" : "");
    e.textContent = headshot ? amount + "!" : amount;
    e.style.left = (x + (Math.random() - 0.5) * 24) + "px";
    e.style.top = y + "px";
    document.body.appendChild(e);
    setTimeout(() => e.remove(), 800);
  }

  hitmarker() {
    const h = this.el.hitmarker;
    h.classList.remove("show"); void h.offsetWidth; h.classList.add("show");
  }

  stateTag(text, color = "#fff") {
    this.el.stateTag.textContent = text;
    this.el.stateTag.style.color = color;
  }
  clearStateTag() { this.el.stateTag.textContent = ""; }

  killfeed(text, mine = true) {
    const e = document.createElement("div");
    e.className = "kf-entry";
    e.style.borderLeftColor = mine ? "#ff9e2c" : "#e8433f";
    e.textContent = text;
    this.el.killfeed.appendChild(e);
    setTimeout(() => e.remove(), 4000);
  }

  chat(pseudo, text, sys = false) {
    const e = document.createElement("div");
    e.className = "chat-msg" + (sys ? " sys" : "");
    e.innerHTML = sys ? `<b>${pseudo}</b> ${text}` : `<b>${pseudo}:</b> ${escapeHtml(text)}`;
    this.el.chatLog.appendChild(e);
    while (this.el.chatLog.children.length > 8) this.el.chatLog.firstChild.remove();
    setTimeout(() => { if (e.parentNode) e.style.opacity = "0.4"; }, 8000);
  }

  endScreen(win, d) {
    this.el.endTitle.textContent = win ? "VICTOIRE" : "DÉFAITE";
    this.el.endTitle.className = win ? "win" : "lose";
    this.el.endScore.textContent = `${d.me} — ${d.opp}`;
    const acc = d.shots ? Math.round(d.hits / d.shots * 100) : 0;
    document.getElementById("end-stats").innerHTML = [
      ["Frags", d.me], ["Morts", d.opp], ["Dégâts", Math.round(d.damage)], ["Précision", acc + "%"],
    ].map(([l, v]) => `<div class="stat-box"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join("");
    // XP par arme (maîtrise gagnée ce match)
    const wxp = d.weaponXp || {};
    const wrows = Object.keys(wxp).filter((k) => wxp[k] > 0);
    document.getElementById("end-weaponxp").innerHTML = wrows.length
      ? wrows.map((id) => `<div class="wxp-row"><span>${WEAPONS[id].name}</span><b>+${wxp[id]} XP</b></div>`).join("")
      : "";
    // XP joueur animé (count-up)
    const xpEl = document.getElementById("end-xp");
    const tgt = d.xp || 0, t0 = performance.now();
    const anim = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      xpEl.textContent = "+" + Math.round(tgt * k) + " XP";
      if (k < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    this.show("endscreen");
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
