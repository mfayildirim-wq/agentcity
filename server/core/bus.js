// Zentraler Ereignisbus: agent.update, agent.remove, event, chat.chunk, chat.message,
// permission.request, permission.resolved, pty.output, pty.exit, task.update, task.remove, meeting.update, meeting.message, toast, tools.update,
// artifact.add, artifact.update;
// intern (nicht an Browser): session.turnEnd
import { EventEmitter } from 'node:events';

// Ereignisse, die unverändert an alle Browser gehen
export const BROADCAST_TYPES = [
  'agent.update', 'agent.remove', 'event', 'chat.chunk', 'chat.message',
  'permission.request', 'permission.resolved', 'pty.output', 'pty.exit',
  'task.update', 'task.remove', 'meeting.update', 'meeting.message', 'toast', 'tools.update',
  'artifact.add', 'artifact.update',
];

export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  return bus;
}
