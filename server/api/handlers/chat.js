// WS-Handler: gespeicherter Chatverlauf eines Agenten (z. B. nach einem Neuladen der Seite)
export default {
  'chat.history'(ctx, msg) {
    if (typeof msg.agentId !== 'string' || !msg.agentId) throw new Error('agentId fehlt');
    const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 400);
    let messages = [];
    try { messages = ctx.repo?.messagesForAgent?.(msg.agentId, limit) ?? []; } catch { /* DB optional */ }
    return { messages };
  },
};
