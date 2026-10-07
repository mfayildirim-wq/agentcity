// WS-Handler: Antwort auf eine Berechtigungsanfrage (optionId 'cancel' = Abbruch)
export default {
  'permission.answer'(ctx, msg) {
    if (!ctx.acp) throw new Error('Steuerung nicht verfügbar');
    if (typeof msg.permissionId !== 'string' || typeof msg.optionId !== 'string') throw new Error('permissionId und optionId nötig');
    return ctx.acp.answerPermission(msg.permissionId, msg.optionId);
  },
};
