// Sons procéduraux (WebAudio) — pas de fichiers externes.
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._noiseBuf = null;
    this._volume = 0.5;   // volume maître [0..1]
  }

  /** Règle le volume maître (persisté via USER.volume). */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this._volume;
  }

  // À appeler sur un geste utilisateur (clic) pour débloquer l'audio.
  init() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume;
    this.master.connect(this.ctx.destination);
    // buffer de bruit blanc réutilisable
    const len = this.ctx.sampleRate * 0.4;
    this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  _noise(dur, vol, filterFreq, type = "lowpass") {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur);
  }

  _tone(freq, dur, vol, type = "square", slideTo = null) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur);
  }

  shoot(weapon) {
    const punch = Math.min(0.5, 0.18 + (weapon.shake || 0.05) * 1.2);
    this._noise(0.09 + (weapon.shake || 0) * 0.4, punch, 1400, "lowpass");
    this._tone(120, 0.08, punch * 0.6, "sawtooth", 60);
  }
  hit() { this._tone(900, 0.05, 0.25, "square"); }
  headshot() { this._tone(1300, 0.05, 0.3, "square"); setTimeout(() => this._tone(1700, 0.05, 0.25, "square"), 45); }
  reload() { this._tone(300, 0.04, 0.18, "square"); setTimeout(() => this._tone(220, 0.05, 0.18, "square"), 130); }
  step() { this._noise(0.05, 0.06, 500, "lowpass"); }
  ui() { this._tone(660, 0.03, 0.12, "triangle"); }
  hurt() { this._tone(160, 0.12, 0.3, "sawtooth", 80); }
  heal() { this._tone(520, 0.06, 0.18, "triangle", 1040); setTimeout(() => this._tone(780, 0.05, 0.12, "triangle", 1200), 60); }
}

export const audio = new AudioEngine();
