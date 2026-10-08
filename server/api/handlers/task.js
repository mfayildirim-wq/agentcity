// WS-Handler: Aufgaben anlegen, ändern (Spalte, Titel, Beschreibung), zuweisen (als Prompt), löschen.
import { need as needIn, str } from './util.js';

const need = (ctx) => needIn(ctx.tasks, 'Aufgaben nicht verfügbar');

export default {
  // optional assigneeId: gleich zuweisen (Aufgabe aus einer Besprechung)
  async 'task.create'(ctx, msg) {
    const tasks = need(ctx);
    const task = tasks.create({
      title: msg.title, description: msg.description ?? null, meetingId: msg.meetingId ?? null, sourceMessageId: msg.sourceMessageId ?? null,
    });
    if (typeof msg.assigneeId === 'string' && msg.assigneeId) {
      try {
        return { task: await tasks.assign(task.id, msg.assigneeId) };
      } catch (err) {
        // Aufgabe bleibt offen angelegt; Fehler trotzdem melden
        throw new Error(`Aufgabe angelegt, aber nicht zugewiesen: ${err.message}`);
      }
    }
    return { task };
  },

  'task.update'(ctx, msg) {
    const patch = {};
    for (const k of ['status', 'title', 'description']) if (msg[k] !== undefined) patch[k] = msg[k];
    return { task: need(ctx).update(str(msg.taskId, 'taskId'), patch) };
  },

  async 'task.assign'(ctx, msg) {
    return { task: await need(ctx).assign(str(msg.taskId, 'taskId'), str(msg.agentId, 'agentId')) };
  },

  'task.delete'(ctx, msg) {
    return need(ctx).remove(str(msg.taskId, 'taskId'));
  },
};
