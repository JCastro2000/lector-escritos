// Descarga de libros del catálogo: uno solo, o toda la biblioteca de una vez, con progreso.
// La descarga masiva nunca arranca sola: la persona la inicia (y ve el tamaño) desde una tarjeta.
import * as db from './db.js';
import { parseEpub } from './epub.js';
import { loadRemote } from './catalog.js';
import { slug } from './text.js';
import { h } from './ui.js';

// `title` (del catálogo) manda sobre el que traiga el EPUB, que a veces viene sin tildes.
export async function importBuffer(buffer, title) {
  const parsed = await parseEpub(buffer);
  if (title) {
    parsed.meta.title = title;
    parsed.meta.id = slug(title); // mismo identificador que usa el catálogo, para no duplicar el libro
  }
  return db.saveBook(parsed);
}

export const fetchBook = (entry) => fetch(new URL(entry.file, new URL('library/', location.href)));

// ---------- Estado de la descarga masiva ----------
export const job = { running: false, done: 0, total: 0, current: '', error: '', cancel: false };
const emit = () => db.notify('downloads');

function friendly(e) {
  if (e?.name === 'QuotaExceededError') return 'No hay espacio suficiente en el teléfono.';
  if (!navigator.onLine || e instanceof TypeError) return 'Se perdió la conexión. Vuelve a intentarlo.';
  return `No se pudo descargar: ${e?.message ?? e}`;
}

let catalogCache = null;
export async function catalog(force = false) {
  if (!catalogCache || force) catalogCache = await loadRemote();
  return catalogCache;
}

// Libros del catálogo que todavía no están en este dispositivo.
export async function missing() {
  const [entries, books] = await Promise.all([catalog(), db.listBooks()]);
  const have = new Set(books.map((b) => b.id));
  const list = entries.filter((e) => !have.has(slug(e.title)));
  return { total: entries.length, downloaded: entries.length - list.length, list, bytes: list.reduce((a, e) => a + (e.size || 0), 0) };
}

export async function downloadAll(list) {
  if (job.running) return;
  Object.assign(job, { running: true, done: 0, total: list.length, current: '', error: '', cancel: false });
  emit();
  let lock = null;
  try {
    lock = (await navigator.wakeLock?.request('screen')) ?? null; // que la pantalla no se apague a mitad
  } catch { /* no disponible */ }
  try {
    for (const entry of list) {
      if (job.cancel) break;
      job.current = entry.title;
      emit();
      const res = await fetchBook(entry);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await importBuffer(await res.arrayBuffer(), entry.title);
      job.done++;
      emit();
    }
  } catch (e) {
    console.error(e);
    job.error = friendly(e);
  } finally {
    job.running = false;
    lock?.release?.();
    emit();
  }
}

const mb = (bytes) => (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1);
const faltan = (n) => (n === 1 ? 'Falta 1 libro' : `Faltan ${n} libros`);
const descargados = (n) => (n === 1 ? '1 libro descargado' : `${n} libros descargados`);

// Tarjeta que ofrece descargar los libros que faltan y muestra el avance.
// intro: texto o función(info) con el mensaje principal. dismissKey: si se pasa, tiene "Más tarde".
export function downloadCard({ intro, dismissKey = null } = {}) {
  const box = h('section', { class: 'dlcard', hidden: true });
  let info = null;

  const dismissed = () => {
    try {
      return !!dismissKey && localStorage.getItem(dismissKey) === '1';
    } catch {
      return false;
    }
  };

  async function refresh() {
    try {
      info = await missing();
    } catch {
      info = null;
    }
    render();
  }

  function render() {
    box.replaceChildren();
    if (job.running) {
      box.append(
        h('p', { class: 'dl-title' }, `Descargando ${Math.min(job.done + 1, job.total)} de ${job.total}…`),
        h('progress', { max: job.total, value: job.done }),
        h('p', { class: 'muted small' }, `${job.current} · Mantén la app abierta.`),
        h('button', { class: 'btn small', onclick: () => { job.cancel = true; } }, 'Cancelar'));
    } else if (job.error && info?.list.length) {
      box.append(
        h('p', { class: 'dl-title' }, job.error),
        h('p', { class: 'muted small' }, `${descargados(job.done)}. ${faltan(info.list.length)}.`),
        h('button', { class: 'btn primary small', onclick: () => downloadAll(info.list) }, 'Reintentar'));
    } else if (info?.list.length && !dismissed()) {
      const text = typeof intro === 'function' ? intro(info) : intro;
      box.append(
        h('p', { class: 'dl-title' }, text),
        h('p', { class: 'muted small' }, `${faltan(info.list.length)} (${mb(info.bytes)} MB). Si puedes, usa Wi-Fi para no gastar datos.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => { job.error = ''; downloadAll(info.list); } }, `Descargar todos (${mb(info.bytes)} MB)`),
          dismissKey && h('button', {
            class: 'btn small',
            onclick: () => {
              try {
                localStorage.setItem(dismissKey, '1');
              } catch { /* sin almacenamiento */ }
              render();
            },
          }, 'Más tarde')));
    } else {
      box.hidden = true;
      return;
    }
    box.hidden = false;
  }

  let timer;
  const onDownloads = () => {
    render();
    if (!job.running) refresh(); // al terminar, recalcula lo que falta
  };
  const onBooks = () => {
    if (job.running) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  db.events.addEventListener('downloads', onDownloads);
  db.events.addEventListener('books', onBooks);
  refresh();

  return {
    el: box,
    dispose: () => {
      clearTimeout(timer);
      db.events.removeEventListener('downloads', onDownloads);
      db.events.removeEventListener('books', onBooks);
    },
  };
}
