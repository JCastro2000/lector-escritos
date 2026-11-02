// Ajustes de lectura (tema, letra, tamaño…) y pantalla de Ajustes.
import * as db from './db.js';
import { h, icon, tabbar, toast, saveFile, installPrompt } from './ui.js';

const KEY = 'lector.settings';
const DEFAULTS = { theme: 'auto', font: 'serif', size: 19, line: 1.65, measure: 'medium', justify: false };

const THEMES = [['auto', 'Auto'], ['light', 'Claro'], ['sepia', 'Sepia'], ['dark', 'Oscuro'], ['black', 'Negro']];
const FONTS = {
  serif: ['Serif', 'Georgia, "Iowan Old Style", "Palatino Linotype", serif'],
  classic: ['Clásica', '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", serif'],
  sans: ['Sans', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
};
const MEASURES = { narrow: ['Estrecho', '32rem'], medium: ['Medio', '40rem'], wide: ['Ancho', '52rem'] };

let state = load();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) };
  } catch {
    return { ...DEFAULTS };
  }
}

function set(key, value) {
  state[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* sin almacenamiento: el ajuste vale solo durante esta sesión */ }
  applySettings();
}

export function applySettings() {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = state.theme === 'auto' ? (dark ? 'dark' : 'light') : state.theme;
  root.style.setProperty('--fs', `${state.size}px`);
  root.style.setProperty('--lh', state.line);
  root.style.setProperty('--ff', FONTS[state.font][1]);
  root.style.setProperty('--measure', MEASURES[state.measure][1]);
  root.classList.toggle('justify', state.justify);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
}

export const followsSystemTheme = () => state.theme === 'auto';

function segmented(options, current, onPick, extra = () => ({})) {
  const group = h('div', { class: 'segmented', role: 'group' });
  for (const [value, label] of options) {
    const btn = h('button', {
      type: 'button',
      class: value === current ? 'on' : '',
      ...extra(value),
      onclick: () => {
        group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
        onPick(value);
      },
    }, label);
    group.append(btn);
  }
  return group;
}

function slider({ min, max, step, value, label, format, onInput }) {
  const out = h('output', {}, format(value));
  const input = h('input', {
    type: 'range', min, max, step, value, 'aria-label': label,
    oninput: () => {
      out.textContent = format(+input.value);
      onInput(+input.value);
    },
  });
  return h('div', { class: 'slider' }, input, out);
}

const row = (label, control) => h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, label), control);

// Controles de lectura; se usan en Ajustes y en la hoja "Apariencia" del lector.
export function settingsPanel() {
  return h('div', { class: 'settings-panel' },
    row('Tema', segmented(THEMES, state.theme, (v) => set('theme', v), (v) => ({ 'data-swatch': v }))),
    row('Tamaño de letra', slider({ min: 14, max: 32, step: 1, value: state.size, label: 'Tamaño de letra', format: (v) => `${v} px`, onInput: (v) => set('size', v) })),
    row('Tipo de letra', segmented(Object.entries(FONTS).map(([k, [name]]) => [k, name]), state.font, (v) => set('font', v), (v) => ({ style: `font-family:${FONTS[v][1]}` }))),
    row('Interlineado', slider({ min: 1.3, max: 2.1, step: 0.05, value: state.line, label: 'Interlineado', format: (v) => v.toFixed(2), onInput: (v) => set('line', v) })),
    row('Ancho del texto', segmented(Object.entries(MEASURES).map(([k, [name]]) => [k, name]), state.measure, (v) => set('measure', v))),
    row('Texto justificado', segmented([['no', 'No'], ['yes', 'Sí']], state.justify ? 'yes' : 'no', (v) => set('justify', v === 'yes'))));
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function installSection() {
  const box = h('section', { class: 'card' }, h('h2', {}, 'Instalar en el teléfono'));
  if (isInstalled()) {
    box.append(h('p', { class: 'muted' }, 'Ya está instalada en este dispositivo.'));
  } else if (installPrompt.event) {
    box.append(h('p', { class: 'muted' }, 'Instálala para abrirla como una app, a pantalla completa y sin conexión.'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          installPrompt.event.prompt();
          await installPrompt.event.userChoice;
          installPrompt.event = null;
        },
      }, 'Instalar app'));
  } else if (isIos()) {
    box.append(h('ol', { class: 'steps' },
      h('li', {}, 'Abre esta página en ', h('b', {}, 'Safari'), '.'),
      h('li', {}, 'Toca el botón ', h('b', {}, 'Compartir'), ' (el cuadrado con la flecha).'),
      h('li', {}, 'Elige ', h('b', {}, 'Añadir a pantalla de inicio'), '.')),
    h('p', { class: 'muted' }, 'Instalada así, el iPhone conserva los libros descargados.'));
  } else {
    box.append(h('ol', { class: 'steps' },
      h('li', {}, 'Abre esta página en ', h('b', {}, 'Chrome'), '.'),
      h('li', {}, 'Toca el menú ', h('b', {}, '⋮'), ' y elige ', h('b', {}, 'Instalar aplicación'), ' (o "Añadir a pantalla de inicio").')));
  }
  return box;
}

function backupSection() {
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const valid = (data.highlights ?? []).filter((x) => x?.id && x.bookId && Number.isInteger(x.start) && Number.isInteger(x.end) && x.text);
        if (!valid.length) throw new Error('vacío');
        await db.putHighlights(valid);
        toast(`${valid.length} destacados importados`);
      } catch {
        toast('El archivo no es un respaldo válido', 4000);
      }
    },
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'Respaldo de destacados'),
    h('p', { class: 'muted' }, 'Tus destacados viven en este dispositivo. Guarda un respaldo para pasarlos a otro teléfono o recuperarlos si borras los datos del navegador.'),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn',
        onclick: async () => {
          const all = await db.listHighlights();
          if (!all.length) return toast('Aún no tienes destacados');
          const data = JSON.stringify({ app: 'lector-escritos', version: 1, exported: new Date().toISOString(), highlights: all }, null, 1);
          await saveFile(`destacados-${new Date().toISOString().slice(0, 10)}.json`, new Blob([data], { type: 'application/json' }));
        },
      }, icon('download', 18), 'Exportar'),
      h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Importar')),
    fileInput);
}

async function storageSection() {
  const box = h('section', { class: 'card' }, h('h2', {}, 'Almacenamiento'));
  const info = h('p', { class: 'muted' }, 'Calculando…');
  box.append(info);
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1);
    info.textContent = `Libros y destacados ocupan ${mb(usage)} MB${quota ? ` de ${mb(quota)} MB disponibles` : ''}.`;
  } catch {
    info.textContent = 'No se pudo calcular el espacio usado.';
  }
  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persisted();
    if (persisted) {
      box.append(h('p', { class: 'muted' }, 'Tus libros y destacados están protegidos: el teléfono no los borrará solo.'));
    } else {
      box.append(
        h('p', { class: 'muted' }, 'Si al teléfono le falta espacio, puede borrar por su cuenta los datos de apps que no usas hace tiempo. Este botón le pide que conserve tus libros y destacados.'),
        h('button', {
          class: 'btn',
          onclick: async () => toast((await navigator.storage.persist()) ? 'Datos protegidos' : 'El teléfono no lo permitió; no pasa nada', 4000),
        }, 'Proteger mis datos'));
    }
  }
  return box;
}

export async function mount(root) {
  root.append(h('div', { class: 'page' },
    h('header', { class: 'head' }, h('h1', {}, 'Ajustes')),
    h('section', { class: 'card' },
      h('h2', {}, 'Lectura'),
      settingsPanel(),
      h('article', { class: 'rtext preview' },
        h('p', { class: 'standard-indented' }, 'Así se verá el texto al leer. Ajusta el tema, el tamaño y la letra hasta que leer sea cómodo.'))),
    backupSection(),
    installSection(),
    await storageSection(),
    h('section', { class: 'card' },
      h('h2', {}, 'Acerca de'),
      h('p', { class: 'muted' }, 'Lector de Escritos guarda todo en este dispositivo: los libros, tu posición y tus destacados. Nada se envía a ningún servidor.'))),
  tabbar('settings'));
}
