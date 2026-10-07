// WS-Handler: Agenten-Tools anzeigen, speichern, löschen (Standard → deaktiviert), testen.
// Vollständige Einträge (Befehl, Argumente, Umgebung) gibt es nur hier – im Snapshot fehlen sie.
const need = (ctx) => {
  if (!ctx.registry?.save) throw new Error('Einstellungen nicht verfügbar');
  return ctx.registry;
};

// geänderte Tool-Liste an alle Browser
const announce = (ctx) => ctx.bus?.emit('tools.update', { tools: ctx.registry.publicList() });

export default {
  'settings.agents.list'(ctx) {
    return { agents: need(ctx).list({ all: true }) };
  },

  'settings.agents.save'(ctx, msg) {
    // isNew: „Neu“-Formular – vorhandene id ablehnen
    const agents = need(ctx).save(msg.agent, { isNew: !!msg.isNew });
    announce(ctx);
    return { agents };
  },

  'settings.agents.delete'(ctx, msg) {
    // `id` ist die Anfrage-Id des Protokolls – das Tool kommt als toolId
    const agents = need(ctx).delete(msg.toolId);
    announce(ctx);
    return { agents };
  },

  async 'settings.agents.test'(ctx, msg) {
    const reg = need(ctx);
    // entweder ein (ungespeicherter) Eintrag oder die toolId eines vorhandenen
    const agent = msg.agent ?? reg.list({ all: true }).find((t) => t.id === msg.toolId);
    if (!agent) throw new Error('Tool nicht gefunden');
    return reg.test(agent);
  },
};
