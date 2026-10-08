// WS-Handler: Besprechungen anlegen, ändern (Teilnehmer, Titel, schließen), Nachrichten senden.
import { need as needIn, str } from './util.js';

const need = (ctx) => needIn(ctx.meetings, 'Besprechungen nicht verfügbar');

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
