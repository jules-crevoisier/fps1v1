// Client réseau (Socket.IO) pour le duel 1v1 en ligne.
// Le serveur expose /socket.io/socket.io.js ; `io` est alors global.
export class Network {
  constructor() {
    this.socket = null;
    this.handlers = {};
    this.connected = false;
  }

  on(event, cb) { this.handlers[event] = cb; }
  _emit(event, data) { if (this.handlers[event]) this.handlers[event](data); }

  connect() {
    if (typeof io === "undefined") {
      this._emit("error", "Socket.IO non chargé (le serveur tourne-t-il ?)");
      return;
    }
    this.socket = io();
    const s = this.socket;
    s.on("connect", () => { this.connected = true; });
    s.on("waiting", () => this._emit("waiting"));
    s.on("mapVote", (d) => this._emit("mapVote", d));
    s.on("matchFound", (d) => this._emit("matchFound", d));
    s.on("kill", (d) => this._emit("kill", d));            // blitz : un kill (sans reset)
    s.on("respawn", (d) => this._emit("respawn", d));      // blitz : ma réapparition
    s.on("opponentState", (d) => this._emit("opponentState", d));
    s.on("hit", (d) => this._emit("hit", d));            // mon tir a touché (autoritaire)
    s.on("damaged", (d) => this._emit("damaged", d));    // j'ai pris des dégâts (autoritaire)
    s.on("healed", (d) => this._emit("healed", d));      // j'ai été soigné (autoritaire)
    s.on("pickupsInit", (d) => this._emit("pickupsInit", d));
    s.on("pickupTaken", (d) => this._emit("pickupTaken", d));
    s.on("roundReset", (d) => this._emit("roundReset", d));
    s.on("gameOver", (d) => this._emit("gameOver", d));
    s.on("opponentLeft", () => this._emit("opponentLeft"));
    s.on("chat", (d) => this._emit("chat", d));
    s.on("disconnect", () => { this.connected = false; this._emit("disconnect"); });
  }

  queue(pseudo, classId, loadout, mapId, mode) { this.socket?.emit("queue", { pseudo, classId, loadout, mapId, mode }); }
  vote(mapId) { this.socket?.emit("vote", mapId); }
  sendState(state) { this.socket?.emit("state", state); }
  sendShot(data) { this.socket?.emit("shot", data); }
  sendChat(text) { this.socket?.emit("chat", text); }
  disconnect() { this.socket?.disconnect(); this.socket = null; }
}
