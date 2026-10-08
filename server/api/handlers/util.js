// Gemeinsame Hilfen der WS-Handler.

// Dienst aus dem Kontext oder Fehler mit Meldung
export const need = (value, message) => {
  if (!value) throw new Error(message);
  return value;
};

// nicht-leerer Text oder Fehler „<name> fehlt“
export const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} fehlt`);
  return v;
};
