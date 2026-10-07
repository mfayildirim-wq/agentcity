// WS-Handler: Besprechungen anlegen, ändern (Teilnehmer, Titel, schließen), Nachrichten senden.
const need = (ctx) => {
  if (!ctx.meetings) throw new Error('Besprechungen nicht verfügbar');
  return ctx.meetings;
};
const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} fehlt`);
  return v;
};

export default {
  'meeting.create'(ctx, msg) {
    return { meeting: need(ctx).create({ title: msg.title ?? null, participantIds: msg.participantIds ?? [] }) };
  },

  'meeting.update'(ctx, msg) {
    const patch = {};
    for (const k of ['participantIds', 'title', 'closed']) if (msg[k] !== undefined) patch[k] = msg[k];
    return { meeting: need(ctx).update(str(msg.meetingId, 'meetingId'), patch) };
  },

  // an alle Teilnehmer oder nur die per @name angesprochenen; Antworten kommen als meeting.update
  async 'meeting.message'(ctx, msg) {
    return need(ctx).message(str(msg.meetingId, 'meetingId'), msg.text);
  },
};
