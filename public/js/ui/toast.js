// Kurze Hinweise unten rechts und ein Banner bei Verbindungsabbruch
const ICONS = {
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15 9l-6 6M9 9l6 6',
};

function host() {
  let el = document.getElementById('toasts');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasts';
    el.className = 'toasts';
    document.body.appendChild(el);
  }
  return el;
}

export function toast(text, level = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path d="${ICONS[level] || ICONS.info}"/></svg><span></span>`;
  el.querySelector('span').textContent = text;
  host().appendChild(el);
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.addEventListener('click', remove);
  setTimeout(remove, ms);
  return el;
}

let banner = null;
export function showBanner(text) {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'banner';
    banner.innerHTML = `<i></i><span></span>`;
    document.body.appendChild(banner);
  }
  banner.querySelector('span').textContent = text;
  banner.classList.remove('hidden');
}

export function hideBanner() { banner?.classList.add('hidden'); }
