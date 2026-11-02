// Piezas de interfaz compartidas: creación de elementos, iconos, avisos, hojas inferiores, barra de pestañas.
export const COLORS = ['yellow', 'green', 'blue', 'pink'];
export const COLOR_NAMES = { yellow: 'Amarillo', green: 'Verde', blue: 'Azul', pink: 'Rosa' };

// Evento de instalación de Chrome/Android, guardado por app.js.
export const installPrompt = { event: null };

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (Array.isArray(kid)) kid.forEach(add);
    else if (kid != null && kid !== false) el.append(kid);
  };
  kids.forEach(add);
  return el;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const uid = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const ICONS = {
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  type: '<path d="M3 19 9 5l6 14M5.2 14h7.6M14 19l3.5-8 3.5 8M15.4 16.6h4.2"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  share: '<path d="M12 15V4m-4 4 4-4 4 4M5 13v6h14v-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5zM4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z"/>',
};

export function icon(name, size = 22) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

let toastTimer;
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

export function openSheet(title, content) {
  const onKey = (e) => e.key === 'Escape' && close();
  const api = { close, body: null, onClose: null };
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    api.onClose?.();
  }
  const body = h('div', { class: 'sheet-body' }, content);
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' },
        h('h2', {}, title),
        h('button', { class: 'iconbtn', 'aria-label': 'Cerrar', onclick: close }, icon('close'))),
      body));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  api.body = body;
  return api;
}

// Confirmación propia (el confirm() del navegador se bloquea en muchas apps instaladas).
export function confirmAction(title, message, okLabel = 'Eliminar') {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      answered = true;
      sheet.close();
      resolve(value);
    };
    const sheet = openSheet(title, h('div', { class: 'stack' },
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => answer(false) }, 'Cancelar'),
        h('button', { class: 'btn primary danger-fill', onclick: () => answer(true) }, okLabel))));
    sheet.onClose = () => !answered && resolve(false);
  });
}

const TABS = [
  ['library', 'Biblioteca', 'book', '#/'],
  ['search', 'Buscar', 'search', '#/search'],
  ['highlights', 'Destacados', 'bookmark', '#/highlights'],
  ['settings', 'Ajustes', 'settings', '#/settings'],
];

export function tabbar(active) {
  return h('nav', { class: 'tabbar', 'aria-label': 'Secciones' },
    TABS.map(([id, label, ic, href]) =>
      h('a', { href, class: id === active ? 'on' : '', 'aria-current': id === active ? 'page' : null }, icon(ic), h('span', {}, label))));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { value: text });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copiado');
}

export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
    } catch { /* cancelado por el usuario */ }
  } else {
    copyText(text);
  }
}

// Entrega un archivo al usuario: hoja de compartir en el móvil, descarga en el computador.
export async function saveFile(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
