// Leinwand im Raum (v0.3): ein CSS3DObject (echtes DOM, 960 × 540 px, Skalierung 0,005 → 4,8 × 2,7 Einheiten) an der
// Rückwand jedes Raums. Zeigt das neueste Artefakt des Raums: Webseite/HTML als iframe (ohne Interaktion), Text als
// Karte (erste ~40 Zeilen), Bild direkt, sonst Hinweiskarte. Chip unten rechts „n Ergebnisse“ mit Punkt bei ungesehenen.
// Modus: live (iframe erlaubt) · card (zu viele/zu weit: Hinweiskarte statt iframe) · off (außerhalb des Bildes).
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { ICON, KIND_ICON, KIND_LABEL, esc, renderMarkdown, fmtBytes } from './ui/common.js';
import { svgIcon } from './config.js';

export const SCREEN_W = 960;
export const SCREEN_H = 540;
export const SCREEN_SCALE = 0.005;
export const MAX_LIVE_SCREENS = 4;
const TEXT_LINES = 40;
const textCache = new Map(); // previewUrl → { key, text }

const isMarkdown = (a) => /\.(md|markdown)$/i.test(a.title ?? a.path ?? '');
const frameSrc = (a) => a.previewUrl ?? a.url ?? null;
const LOGO = '<svg viewBox="0 0 32 32" class="sc-logo"><path d="M16 2 29 16 16 30 3 16Z"/></svg>';

export class Screen {
  constructor() {
    const el = document.createElement('div');
    el.className = 'screen';
    el.innerHTML = `<div class="sc-body"></div><div class="sc-chip"><i></i><span></span></div>`;
    this.el = el;
    this.bodyEl = el.querySelector('.sc-body');
    this.chipEl = el.querySelector('.sc-chip');
    this.chipText = el.querySelector('.sc-chip span');
    this.object = new CSS3DObject(el);
    this.object.scale.setScalar(SCREEN_SCALE);
    this.artifact = null;
    this.mode = 'live';
    this.count = 0;
    this.unseen = 0;
    this.sig = null;
  }

  // Artefakt (oder null = leer) und Zähler setzen; neu zeichnen nur bei Änderung
  setArtifact(a, count = 0, unseen = 0) {
    this.artifact = a ?? null;
    this.count = count;
    this.unseen = unseen;
    this.chipText.textContent = count === 1 ? '1 Ergebnis' : `${count} Ergebnisse`;
    this.chipEl.classList.toggle('hidden', !count);
    this.chipEl.classList.toggle('unseen', unseen > 0);
    this.draw();
  }

  // live | card | off (siehe oben)
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.draw();
  }

  draw() {
    const a = this.artifact;
    const sig = a ? `${a.id}:${a.updatedAt}:${a.ended ? 1 : 0}:${this.mode}` : `leer:${this.mode}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.classList.toggle('off', this.mode === 'off');
    const b = this.bodyEl;
    if (this.mode === 'off') { b.innerHTML = ''; return; }
    if (!a) { b.innerHTML = `<div class="sc-empty">${LOGO}<span>Noch keine Ergebnisse</span></div>`; return; }
    if (a.kind === 'text') {
      if (a.content != null) { b.innerHTML = this.textHtml(a, a.content); return; }
      const src = frameSrc(a);
      const cached = src && textCache.get(src);
      if (cached?.key === a.updatedAt) { b.innerHTML = this.textHtml(a, cached.text); return; }
      b.innerHTML = this.cardHtml(a);
      if (!src) return;
      fetch(src, { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then((text) => {
          textCache.set(src, { key: a.updatedAt, text });
          if (textCache.size > 40) textCache.delete(textCache.keys().next().value);
          if (this.artifact?.id === a.id && this.mode !== 'off') b.innerHTML = this.textHtml(a, text);
        }).catch(() => {});
      return;
    }
    if (a.kind === 'image' && frameSrc(a)) { b.innerHTML = `<div class="sc-img"><img src="${esc(frameSrc(a))}" alt=""></div>`; return; }
    if ((a.kind === 'web' || a.kind === 'html') && frameSrc(a) && this.mode === 'live' && !a.ended) {
      const sandbox = a.kind === 'web' ? 'allow-scripts allow-same-origin' : 'allow-scripts';
      b.innerHTML = `<iframe class="sc-frame" sandbox="${sandbox}" referrerpolicy="no-referrer" tabindex="-1" src="${esc(frameSrc(a))}"></iframe>`;
      return;
    }
    b.innerHTML = this.cardHtml(a);
  }

  textHtml(a, text) {
    const lines = String(text ?? '').split('\n').slice(0, TEXT_LINES).join('\n');
    const inner = isMarkdown(a) ? `<div class="sc-md">${renderMarkdown(lines)}</div>` : `<pre class="sc-code">${esc(lines)}</pre>`;
    return `<div class="sc-text"><div class="sc-text-head">${svgIcon(ICON.text)}<span>${esc(a.title ?? '')}</span></div>${inner}</div>`;
  }

  // Hinweiskarte: Icon, Name, Art (und Größe), Hinweis „Öffnen“
  cardHtml(a) {
    const note = a.ended ? 'beendet' : this.mode === 'card' && (a.kind === 'web' || a.kind === 'html') ? 'Vorschau im Ergebnis-Frame' : '';
    return `<div class="sc-card">${svgIcon(ICON[KIND_ICON[a.kind]] ?? ICON.file)}<b>${esc(a.title ?? a.url ?? '')}</b>
      <span>${esc(KIND_LABEL[a.kind] ?? a.kind)}${a.size != null ? ` · ${esc(fmtBytes(a.size))}` : ''}${note ? ` · ${esc(note)}` : ''}</span>
      <em>${svgIcon(ICON.external)}Öffnen</em></div>`;
  }

  dispose() {
    this.bodyEl.innerHTML = '';
    this.object.removeFromParent();
    this.el.remove();
  }
}
