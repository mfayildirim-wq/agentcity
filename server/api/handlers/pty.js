// WS-Handler für Terminals: Nutzer-Shell je Agent (öffnen, Eingabe, Größe, schließen) und
// Liste der Agenten-Terminals mit Puffer (Wiederanzeige nach dem Neuladen).
const MAX_INPUT = 64 * 1024;

const need = (ctx) => {
  if (!ctx.pty) throw new Error('Terminals nicht verfügbar');
  return ctx.pty;
};
const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} fehlt`);
  return v;
};

// Nur Nutzer-Shells nehmen Eingaben an; Agenten-Terminals sind schreibgeschützt
function userTerm(pty, ptyId) {
  const t = pty.get(str(ptyId, 'ptyId'));
  if (!t) throw new Error('Terminal nicht gefunden');
  if (t.kind !== 'user') throw new Error('Agenten-Terminals sind schreibgeschützt');
  return t;
}

export default {
  // Nutzer-Shell im Projektordner eines steuerbaren Agenten; eine je Agent, wird wiederverwendet
  'pty.open'(ctx, msg) {
    const pty = need(ctx);
    const agentId = str(msg.agentId, 'agentId');
    const a = ctx.state.get(agentId);
    if (!a) throw new Error('Agent nicht gefunden');
    if (a.kind !== 'main' || !ctx.acp?.has?.(agentId)) throw new Error('Terminal nur für steuerbare Sessions');
    if (!a.cwd) throw new Error('Projektordner unbekannt');
    const existing = pty.userShell(agentId);
    if (existing) {
      if (msg.cols && msg.rows) pty.resize(existing, msg.cols, msg.rows);
      return { ptyId: existing, buffer: pty.buffer(existing), reused: true };
    }
    const { ptyId } = pty.open({ kind: 'user', agentId, cwd: a.cwd, cols: msg.cols, rows: msg.rows });
    return { ptyId, buffer: '', reused: false };
  },

  'pty.input'(ctx, msg) {
    const pty = need(ctx);
    const t = userTerm(pty, msg.ptyId);
    if (typeof msg.data !== 'string' || msg.data.length > MAX_INPUT) throw new Error('Ungültige Eingabe');
    pty.write(t.ptyId, msg.data);
    return { ok: true };
  },

  'pty.resize'(ctx, msg) {
    const pty = need(ctx);
    const t = userTerm(pty, msg.ptyId);
    pty.resize(t.ptyId, msg.cols, msg.rows);
    return { ok: true };
  },

  'pty.close'(ctx, msg) {
    const pty = need(ctx);
    const t = userTerm(pty, msg.ptyId);
    pty.close(t.ptyId);
    return { ok: true };
  },

  // Terminals eines Agenten (inkl. Subagenten) mit Ringpuffer; älteste zuerst
  'pty.list'(ctx, msg) {
    const pty = need(ctx);
    const agentId = str(msg.agentId, 'agentId');
    const terminals = pty.listFor(agentId).sort((x, y) => x.t - y.t).map((t) => ({ ...t, data: pty.buffer(t.ptyId) }));
    return { terminals };
  },
};
