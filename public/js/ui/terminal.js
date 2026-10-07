// Terminals im Browser (xterm.js, ohne Bundler aus /vendor geladen):
//   ShellView     – Nutzer-Shell des ausgewählten Agenten (in der Chat-Leiste, Umschalter Chat ⇄ Terminal)
//   OutputView    – schreibgeschützte, kleine Ansicht eines Agenten-Terminals (Reiter „Terminalausgaben“)
const THEME = {
  background: '#11151c', foreground: '#d8dce3', cursor: '#d97757', cursorAccent: '#11151c',
  selectionBackground: 'rgba(217, 119, 87, 0.3)',
  black: '#1b2029', red: '#e5534b', green: '#3fb67a', yellow: '#d9a62e', blue: '#4c8df6', magenta: '#9b8afb', cyan: '#2bb3c8', white: '#c9ced8',
  brightBlack: '#6f7786', brightRed: '#f2867f', brightGreen: '#6fd39d', brightYellow: '#f0c45a', brightBlue: '#7aaaf8', brightMagenta: '#b9acfc', brightCyan: '#5fd0e0', brightWhite: '#ffffff',
};
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

let loading = null;
export function loadXterm() {
  loading ??= Promise.all([import('/vendor/xterm/lib/xterm.mjs'), import('/vendor/xterm-fit/lib/addon-fit.mjs')])
    .then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }))
    .catch((err) => { loading = null; throw err; });
  return loading;
}

// xterm-Instanz in einem eigenen, wiederverwendbaren Element (lässt sich zwischen Neuzeichnungen umhängen)
class XtermBox {
  constructor({ readOnly = false, fontSize = 12, onData, onResize } = {}) {
    this.el = document.createElement('div');
    this.el.className = `xt ${readOnly ? 'ro' : ''}`;
    this.readOnly = readOnly;
    this.fontSize = fontSize;
    this.onData = onData;
    this.onResize = onResize;
    this.term = null;
    this.queue = [];
    this.ready = loadXterm().then(({ Terminal, FitAddon }) => {
      this.term = new Terminal({
        theme: readOnly ? { ...THEME, cursor: THEME.background } : THEME,
        fontFamily: FONT, fontSize, lineHeight: 1.15, scrollback: readOnly ? 3000 : 5000,
        cursorBlink: !readOnly, disableStdin: readOnly, convertEol: false, allowProposedApi: false,
      });
      this.fit = new FitAddon();
      this.term.loadAddon(this.fit);
      this.term.open(this.el);
      if (!readOnly) this.term.onData((d) => this.onData?.(d));
      this.term.onResize(({ cols, rows }) => this.onResize?.(cols, rows));
      for (const d of this.queue) this.term.write(d);
      this.queue = [];
      this.observer = new ResizeObserver(() => this.refit());
      this.observer.observe(this.el);
      this.refit();
      return this;
    });
  }

  refit() {
    if (!this.term || !this.el.isConnected || !this.el.clientWidth || !this.el.clientHeight) return;
    try { this.fit.fit(); } catch { /* noch nicht sichtbar */ }
  }

  write(data) { if (this.term) this.term.write(data); else this.queue.push(data); }

  reset(data = '') {
    if (!this.term) { this.queue = [data]; return; }
    this.term.reset();
    if (data) this.term.write(data);
  }

  focus() { this.term?.focus(); }
  get size() { return this.term ? { cols: this.term.cols, rows: this.term.rows } : { cols: 100, rows: 24 }; }

  dispose() {
    this.observer?.disconnect();
    this.term?.dispose();
    this.el.remove();
  }
}

// Nutzer-Shell: pty.open beim ersten Anzeigen (je Agent eine Shell, der Server liefert den Puffer mit)
export class ShellView {
  constructor({ request, send, store, toast }) {
    this.request = request;
    this.send = send;
    this.store = store;
    this.toast = toast;
    this.agentId = null;
    this.ptyId = null;
    this.exited = false;
    this.opening = null;
    this.resizeTimer = null;
    this.early = ''; // Eingabe, bevor die Shell bereit ist
    this.box = new XtermBox({
      fontSize: 12,
      onData: (d) => this.input(d),
      onResize: (cols, rows) => this.resized(cols, rows),
    });
    this.el = this.box.el;
    store.onPty((m) => {
      if (m.ptyId !== this.ptyId) return;
      if (m.type === 'output') this.box.write(m.data);
      if (m.type === 'exit') {
        this.exited = true;
        this.box.write('\r\n\x1b[2m[Shell beendet – Taste drücken für eine neue Shell]\x1b[0m\r\n');
      }
    });
  }

  // Shell des Agenten anzeigen (öffnet bzw. verbindet neu)
  async show(agentId) {
    if (agentId === this.agentId && this.ptyId && !this.exited) { this.focusSoon(); return; }
    this.agentId = agentId;
    this.ptyId = null;
    this.exited = false;
    this.early = '';
    await this.open();
  }

  async open() {
    const agentId = this.agentId;
    if (!agentId) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        await this.box.ready;
        this.box.refit();
        const { cols, rows } = this.box.size;
        const res = await this.request('pty.open', { agentId, cols, rows });
        if (this.agentId !== agentId) return;
        this.ptyId = res.ptyId;
        this.exited = false;
        this.store.upsertTerminal({ ptyId: res.ptyId, agentId, ownerId: agentId, kind: 'user', command: 'shell', t: Date.now() });
        this.box.reset(res.buffer || '');
        if (this.early) { this.send('pty.input', { ptyId: res.ptyId, data: this.early }); this.early = ''; }
        if (res.reused) this.send('pty.resize', { ptyId: res.ptyId, cols, rows });
        this.focusSoon();
      } catch (err) {
        this.box.reset(`\x1b[31m${err.message}\x1b[0m\r\n`);
      } finally {
        this.opening = null;
        // während des Öffnens auf einen anderen Agenten gewechselt → dessen Shell jetzt öffnen
        if (this.agentId && this.agentId !== agentId && !this.ptyId) this.open();
      }
    })();
    return this.opening;
  }

  // nach Wiederverbindung: Puffer neu holen (Ausgabe während der Trennung fehlt sonst)
  resync() {
    if (!this.agentId || !this.el.isConnected) { this.ptyId = null; return; }
    this.ptyId = null;
    this.open();
  }

  input(data) {
    if (this.exited) { this.ptyId = null; this.open(); return; }
    if (this.ptyId) this.send('pty.input', { ptyId: this.ptyId, data });
    else if (this.early.length < 4096) this.early += data;
  }

  resized(cols, rows) {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.ptyId && !this.exited) this.send('pty.resize', { ptyId: this.ptyId, cols, rows });
    }, 80);
  }

  focusSoon() { requestAnimationFrame(() => { this.box.refit(); this.box.focus(); }); }

  // Agent weg: Ansicht leeren (die Shell beendet der Server beim Schließen der Session)
  detach() {
    if (!this.agentId && !this.ptyId) return;
    this.agentId = null;
    this.ptyId = null;
    this.early = '';
    this.box.reset('');
  }
}

// Schreibgeschützte Ausgabe eines Agenten-Terminals; das Element wird beim Neuzeichnen der Detailkarte umgehängt
export class OutputView {
  constructor({ store }) {
    this.store = store;
    this.ptyId = null;
    this.box = new XtermBox({ readOnly: true, fontSize: 11 });
    this.el = this.box.el;
    store.onPty((m) => {
      if (m.ptyId !== this.ptyId) return;
      if (m.type === 'output') this.box.write(m.data);
    });
  }

  // in den Platzhalter `slot` hängen und ggf. auf ein anderes Terminal umschalten
  attach(slot, ptyId) {
    if (!slot) return;
    if (this.el.parentNode !== slot) slot.appendChild(this.el);
    if (ptyId !== this.ptyId) {
      this.ptyId = ptyId;
      this.box.reset(this.store.state.terminals.get(ptyId)?.data ?? '');
    }
    requestAnimationFrame(() => this.box.refit());
  }

  // Puffer neu (z. B. nach pty.list)
  reload() {
    if (this.ptyId) this.box.reset(this.store.state.terminals.get(this.ptyId)?.data ?? '');
  }
}
