// Arranque y navegación por hash: #/ (biblioteca), #/read/<libro>/<cap>/<bloque>, #/search, #/highlights, #/settings
import { applySettings, followsSystemTheme } from './settings.js';
import { installPrompt, h } from './ui.js';
import * as library from './library.js';
import * as reader from './reader.js';
import * as search from './search.js';
import * as highlights from './highlights.js';
import * as settings from './settings.js';
import * as sync from './sync.js';

const VIEWS = { library, read: reader, search, highlights, settings };

applySettings();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => followsSystemTheme() && applySettings());

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt.event = e;
});

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
}

history.scrollRestoration = 'manual';

sync.start(); // solo hace algo si ya hay una sesión iniciada en este dispositivo

function parseHash() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = '', ...args] = path.split('/').map(decodeURIComponent);
  return { name: name || 'library', args, query: new URLSearchParams(qs) };
}

let cleanup;
let navId = 0;

async function route() {
  const id = ++navId;
  cleanup?.();
  cleanup = null;
  const { name, args, query } = parseHash();
  const view = VIEWS[name] ?? library;
  const root = document.getElementById('app');
  root.replaceChildren();
  root.className = `view-${VIEWS[name] ? name : 'library'}`;
  window.scrollTo(0, 0);
  try {
    const stop = await view.mount(root, { args, query });
    if (id === navId) cleanup = stop;
    else stop?.();
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('div', { class: 'page empty' },
      h('h2', {}, 'Algo salió mal'),
      h('p', {}, e.message),
      h('a', { class: 'btn primary', href: '#/' }, 'Volver a la biblioteca')));
  }
}

addEventListener('hashchange', route);
route();
