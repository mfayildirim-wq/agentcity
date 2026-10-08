// Kleine gemeinsame Hilfen (Server).

// Leerraum zusammenfassen und auf n Zeichen kürzen (mit „…“); null/undefined → null
export const trunc = (s, n) => {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Promise mit Zeitlimit (z. B. für initialize/newSession/loadSession)
export function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: keine Antwort nach ${Math.round(ms / 1000)} s`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
