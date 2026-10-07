// WS-Handler: Sessions starten, Prompts senden, abbrechen, übernehmen, schließen, Modus wechseln.
const need = (ctx) => {
  if (!ctx.acp) throw new Error('Steuerung nicht verfügbar');
  return ctx.acp;
};
const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} fehlt`);
  return v;
};

export default {
  async 'session.create'(ctx, msg) {
    const agentId = await need(ctx).createSession({
      toolId: str(msg.toolId, 'toolId'), cwd: str(msg.cwd, 'cwd'), mode: msg.mode ?? 'confirm',
      title: typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim().slice(0, 120) : null,
    });
    return { agentId };
  },

  // Antwortet sofort; der Verlauf kommt als chat.*/event/agent.update
  async 'session.prompt'(ctx, msg) {
    const acp = need(ctx);
    let early = null;
    const run = acp.prompt(str(msg.agentId, 'agentId'), msg.text, { meetingId: msg.meetingId ?? null });
    run.catch((err) => { early = err; });
    await new Promise((r) => setImmediate(r));
    if (early) throw early;
    return { ok: true };
  },

  async 'session.cancel'(ctx, msg) {
    await need(ctx).cancel(str(msg.agentId, 'agentId'));
    return { ok: true };
  },

  async 'session.adopt'(ctx, msg) {
    return { agentId: await need(ctx).adopt(str(msg.agentId, 'agentId')) };
  },

  async 'session.close'(ctx, msg) {
    return need(ctx).close(str(msg.agentId, 'agentId'));
  },

  async 'session.setMode'(ctx, msg) {
    return need(ctx).setMode(str(msg.agentId, 'agentId'), str(msg.modeId, 'modeId'));
  },
};
