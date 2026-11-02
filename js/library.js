// Biblioteca: todos los libros (descargados y disponibles), favoritos, importar EPUB y descargar del catálogo.
import * as db from './db.js';
import { parseEpub } from './epub.js';
import { CATEGORY_ORDER, categoryOf, loadRemote } from './catalog.js';
import { norm, slug } from './text.js';
import { h, icon, toast, tabbar } from './ui.js';

const enc = encodeURIComponent;
const PREFS = 'lector.library';
const FAVS = 'lector.favorites';

// `title` (del catálogo) manda sobre el que traiga el EPUB, que a veces viene sin tildes.
export async function importBuffer(buffer, title) {
  const parsed = await parseEpub(buffer);
  if (title) parsed.meta.title = title;
  return db.saveBook(parsed);
}

const readJson = (key, fallback) => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key)) };
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* sin almacenamiento: vale solo durante esta sesión */ }
};

function placeholder(title) {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return h('div', { class: 'cover ph', style: `background:hsl(${hash} 32% 30%)` }, h('span', {}, title));
}

export async function mount(root) {
  let books = await db.listBooks();
  let remote = [];
  let urls = [];
  let filter = '';
  const busy = new Set();
  const prefs = readJson(PREFS, { mode: 'all', sort: 'category' });
  if (prefs.mode !== 'favorites') prefs.mode = 'all'; // la pestaña "Descargados" ya no existe
  let favs = new Set(readJson(FAVS, { ids: [] }).ids);

  const body = h('div', { class: 'lib-body' });
  // Búsqueda por título: se abre con el botón flotante y se queda fija arriba.
  const titleInput = h('input', {
    type: 'search', class: 'searchbox', placeholder: 'Buscar un libro por título…', 'aria-label': 'Buscar un libro por título',
    autocomplete: 'off', enterkeyhint: 'search',
    oninput: () => {
      filter = titleInput.value;
      render();
    },
  });
  const searchBar = h('div', { class: 'libsearch', hidden: true }, titleInput);
  const fab = h('button', { class: 'fab', 'aria-label': 'Buscar un libro por título', onclick: toggleSearch }, icon('search', 24));

  function toggleSearch() {
    const opening = searchBar.hidden;
    searchBar.hidden = !opening;
    fab.replaceChildren(icon(opening ? 'close' : 'search', 24));
    fab.setAttribute('aria-label', opening ? 'Cerrar la búsqueda' : 'Buscar un libro por título');
    if (opening) {
      window.scrollTo(0, 0);
      titleInput.focus();
    } else {
      titleInput.value = '';
      filter = '';
      render();
    }
  }

  root.append(
    h('div', { class: 'page' },
      h('header', { class: 'head' }, h('h1', {}, 'Mi biblioteca')),
      searchBar,
      body),
    fab,
    tabbar('library'));

  const coverUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  };

  // ---------- Datos ----------
  // Un solo listado: lo descargado más lo del catálogo que aún no está en el dispositivo.
  function items() {
    const map = new Map();
    for (const b of books) map.set(b.id, { id: b.id, title: b.title, book: b, entry: null });
    for (const e of remote) {
      const id = slug(e.title);
      if (map.has(id)) map.get(id).entry = e;
      else map.set(id, { id, title: e.title, book: null, entry: e });
    }
    for (const it of map.values()) {
      const wanted = it.entry?.category;
      it.category = CATEGORY_ORDER.includes(wanted) ? wanted : categoryOf(it.title);
      it.fav = favs.has(it.id);
    }
    return [...map.values()];
  }

  function savePrefs(patch) {
    Object.assign(prefs, patch);
    writeJson(PREFS, prefs);
    render();
  }

  function toggleFav(it) {
    if (favs.has(it.id)) favs.delete(it.id);
    else favs.add(it.id);
    writeJson(FAVS, { ids: [...favs] });
    render();
  }

  // ---------- Acciones ----------
  async function download(it, quiet = false) {
    busy.add(it.id);
    render();
    try {
      const res = await fetch(new URL(it.entry.file, new URL('library/', location.href)));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await importBuffer(await res.arrayBuffer(), it.title);
      if (!quiet) toast(`"${it.title}" descargado`);
    } catch (e) {
      console.error(e);
      toast('No se pudo descargar. ¿Hay conexión a internet?', 4000);
      busy.delete(it.id);
      return false;
    }
    busy.delete(it.id);
    books = await db.listBooks();
    render();
    return true;
  }

  // Tocar un libro de la nube lo descarga (para leerlo también sin conexión) y lo abre.
  async function openRemote(it) {
    if (await download(it, true)) location.hash = `#/read/${enc(it.id)}`;
  }

  // ---------- Piezas ----------
  function tile(it) {
    const downloaded = !!it.book;
    const loading = busy.has(it.id);
    const cover = it.book?.cover ? h('img', { src: coverUrl(it.book.cover), alt: '', loading: 'lazy' })
      : it.entry?.cover ? h('img', { src: `library/${it.entry.cover}`, alt: '', loading: 'lazy' })
        : placeholder(it.title);
    const badge = downloaded
      ? h('span', { class: 'badge ok', title: 'Descargado' }, icon('check', 16))
      : h('span', { class: 'badge', title: 'Toca para descargar' }, loading ? h('span', { class: 'spin' }) : icon('download', 16));
    const inner = [h('div', { class: 'cover' }, cover, badge), h('div', { class: 'tile-title' }, it.title)];

    return h('div', { class: `tile${downloaded ? '' : ' remote'}` },
      downloaded
        ? h('a', { class: 'tile-link', href: `#/read/${enc(it.id)}` }, inner)
        : h('button', { class: 'tile-link', disabled: loading, 'aria-label': `Descargar y abrir ${it.title}`, onclick: () => openRemote(it) }, inner),
      h('button', {
        class: `tile-fav iconbtn${it.fav ? ' on' : ''}`, 'aria-pressed': it.fav ? 'true' : 'false',
        'aria-label': it.fav ? `Quitar ${it.title} de favoritos` : `Añadir ${it.title} a favoritos`,
        onclick: () => toggleFav(it),
      }, icon('star', 18)));
  }

  const shelf = (title, tiles, action) => h('section', { class: 'shelf' },
    h('div', { class: 'shelf-head' }, h('h2', {}, title), action),
    h('div', { class: 'grid' }, tiles));

  function segmented(options, current, onPick) {
    return h('div', { class: 'segmented' }, options.map(([value, label]) =>
      h('button', { class: value === current ? 'on' : '', onclick: () => onPick(value) }, label)));
  }

  function render() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    body.replaceChildren();

    const all = items();
    if (!all.length) {
      body.append(h('div', { class: 'empty' },
        icon('book', 48),
        h('h2', {}, 'No hay libros disponibles'),
        h('p', {}, 'Conéctate a internet y abre la biblioteca de nuevo para ver los libros que puedes descargar.')));
      return;
    }

    const counts = { all: all.length, favorites: all.filter((i) => i.fav).length };

    const last = books.filter((b) => b.lastRead).sort((a, b) => b.lastRead - a.lastRead)[0];
    if (last && prefs.mode !== 'favorites') {
      const chapter = last.toc[last.pos?.c ?? 0];
      body.append(h('a', { class: 'continue', href: `#/read/${enc(last.id)}` },
        h('div', { class: 'cover small' }, last.cover ? h('img', { src: coverUrl(last.cover), alt: '' }) : placeholder(last.title)),
        h('div', {},
          h('div', { class: 'eyebrow' }, 'Continuar leyendo'),
          h('div', { class: 'continue-title' }, last.title),
          chapter && h('div', { class: 'muted small' }, chapter))));
    }

    body.append(h('div', { class: 'lib-tools' },
      segmented([['all', `Todos ${counts.all}`], ['favorites', `Favoritos ${counts.favorites}`]],
        prefs.mode, (mode) => savePrefs({ mode })),
      segmented([['category', 'Por categoría'], ['az', 'A–Z']], prefs.sort, (sort) => savePrefs({ sort }))));

    const term = norm(filter);
    const shown = all
      .filter((i) => prefs.mode !== 'favorites' || i.fav)
      .filter((i) => !term || norm(i.title).includes(term))
      .sort((a, b) => a.title.localeCompare(b.title, 'es'));

    if (!shown.length) {
      body.append(h('p', { class: 'muted center pad' }, term ? 'Ningún libro coincide.' : 'Marca libros con la estrella para verlos aquí.'));
      return;
    }

    if (prefs.sort === 'az') {
      body.append(shelf('Todos los libros', shown.map(tile)));
      return;
    }

    const groups = new Map();
    for (const it of shown) {
      if (!groups.has(it.category)) groups.set(it.category, []);
      groups.get(it.category).push(it);
    }
    for (const cat of CATEGORY_ORDER) {
      if (groups.has(cat)) body.append(shelf(cat, groups.get(cat).map(tile)));
    }
  }

  render();
  loadRemote().then((list) => {
    remote = list;
    if (list.length) render();
  });

  return () => urls.forEach((u) => URL.revokeObjectURL(u));
}
