#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// Einstieg: prüft die Node-Version (node:sqlite ohne Flag ab 22.13), setzt restriktive Dateirechte und lädt dann
// den eigentlichen Server. Statische Importe von node:sqlite würden auf älteren Versionen vor der Prüfung scheitern.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_NODE = [22, 13];

export function nodeVersionOk(version = process.versions.node, min = MIN_NODE) {
  const [major = 0, minor = 0] = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

// realpath: als Befehl `agentcity` (npm link) zeigt argv[1] auf einen Symlink
const isMain = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (!nodeVersionOk()) {
    console.error(`\n  Agent City braucht Node.js ${MIN_NODE.join('.')} oder neuer (gefunden: ${process.versions.node}).`);
    console.error('  Bitte Node aktualisieren, z. B. mit nvm:  nvm install 22 && nvm use 22\n');
    process.exit(1);
  }
  // neue Dateien (Datenbank, WAL, Sperrdatei, Token) nur für den eigenen Nutzer
  process.umask(0o077);
  await import('./index.js');
}
