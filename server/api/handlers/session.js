// WS-Handler: Sessions starten, Prompts senden, abbrechen, übernehmen, schließen, Modus wechseln.
import { need as needIn, str } from './util.js';

const need = (ctx) => needIn(ctx.acp, 'Steuerung nicht verfügbar');

export default {
  async 'session.create'(ctx, msg) {
    const agentId = await need(ctx).createSession({
      toolId: str(msg.toolId, 'toolId'), cwd: str(msg.cwd, 'cwd'), mode: msg.mode ?? 'confirm',
      title: typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim().slice(0, 120) : null,
    });
    return { agentId };
  },

  // Antwortet sofort; der Verlauf kommt als chat.*/event/agent.update.
  // Ein meetingId vom Client wird ignoriert – Besprechungs-Prompts entstehen nur serverseitig (meetings.js).
  async 'session.prompt'(ctx, msg) {
    const acp = need(ctx);
    let early = null;
    const run = acp.prompt(str(msg.agentId, 'agentId'), msg.text);
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

  // Modus des Tools (ACP session/set_mode)
  async 'session.setMode'(ctx, msg) {
    return need(ctx).setMode(str(msg.agentId, 'agentId'), str(msg.modeId, 'modeId'));
  },

  // City-Modus: 'confirm' = Rückfragen im Browser, 'auto' = automatisch freigeben
  'session.setCityMode'(ctx, msg) {
    return need(ctx).setCityMode(str(msg.agentId, 'agentId'), str(msg.cityMode, 'cityMode'));
  },
};
