// Gestion clavier + souris + pointer lock.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.fireDown = false;
    this.adsDown = false;     // clic droit = visée (ADS)
    this.locked = false;
    this._chatOpen = false;

    addEventListener("keydown", (e) => {
      if (this._chatOpen) return;
      this.keys[e.code] = true;
    });
    addEventListener("keyup", (e) => { this.keys[e.code] = false; });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.fireDown = true;
      if (e.button === 2) this.adsDown = true;
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireDown = false;
      if (e.button === 2) this.adsDown = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clear();   // évite les touches "collées"
    });

    // Perte de focus (alt-tab, clic hors fenêtre) : on ne reçoit plus les keyup
    addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.clear(); });
  }

  // Réinitialise tous les états d'entrée (anti-touche bloquée).
  clear() {
    this.keys = {};
    this.fireDown = false;
    this.adsDown = false;
    this.mouseDX = 0; this.mouseDY = 0;
  }

  setChatOpen(open) {
    this._chatOpen = open;
    if (open) this.clear();
  }

  requestLock() {
    if (!this._chatOpen) this.canvas.requestPointerLock();
  }

  // Consomme le delta souris accumulé depuis la dernière frame
  consumeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return [dx, dy];
  }

  down(code) { return !!this.keys[code]; }
}
