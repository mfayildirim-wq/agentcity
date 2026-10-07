// Sammelt die WS-Handler aller Bereiche. Jeder Bereich exportiert ein Objekt
// { '<typ>': (ctx, msg) => result }. Spätere Pakete ergänzen session, permission, pty, …

export function createHandlers(...groups) {
  const handlers = {};
  for (const g of groups) {
    for (const [type, fn] of Object.entries(g)) {
      if (handlers[type]) throw new Error(`Handler doppelt registriert: ${type}`);
      handlers[type] = fn;
    }
  }
  return handlers;
}
