// Buscador de citas: frase exacta primero, luego párrafos que contienen todas las palabras.
import * as db from './db.js';
import { h, esc, tabbar, debounce, icon } from './ui.js';
import { makeMatcher, matchText } from './text.js';
import { downloadCard, job, missing } from './downloads.js';

const enc = encodeURIComponent;
const PAGE = 40;
const template = document.createElement('template');
const plain = (html) => {
  template.innerHTML = html;
  return template.content.textContent;
};
const stripMarkers = (s) => esc(s.replace(/\s*\[\d+\]\s*/g, ' '));

function pageNear(text, offset, base) {
  let page = base;
  for (const m of text.slice(0, offset).matchAll(/\[(\d+)\]/g)) page = +m[1];
  return page;
}

export async function mount(root, ctx) {
  let books = [];
  let byId = new Map();
  let order = new Map();
  async function loadBooks() {
    books = (await db.listBooks()).sort((a, b) => a.title.localeCompare(b.title, 'es'));
    byId = new Map(books.map((b) => [b.id, b]));
    order = new Map(books.map((b, i) => [b.id, i]));
  }
  await loadBooks();
  const focusBook = byId.has(ctx.query.get('book')) ? ctx.query.get('book') : null;

  let onlyBook = !!focusBook;
  let runId = 0;
  let hits = [];
  let shown = 0;
  const chapters = new Map();

  const input = h('input', {
    type: 'search', class: 'searchbox', placeholder: 'Escribe una frase o palabras…', value: ctx.query.get('q') ?? '',
    enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': 'Buscar en los libros', oninput: debounce(run, 300),
  });
  const scope = h('div', { class: 'segmented' });
  const status = h('p', { class: 'muted status' });
  const list = h('div', { class: 'hits' });
  const moreBtn = h('button', { class: 'btn', hidden: true, onclick: () => more(runId) }, 'Mostrar más');

  if (focusBook) {
    const all = h('button', { onclick: () => setScope(false) }, 'Todos los libros');
    const one = h('button', { class: 'on', onclick: () => setScope(true) }, `Solo: ${byId.get(focusBook).title}`);
    scope.append(all, one);
    function setScope(value) {
      onlyBook = value;
      one.classList.toggle('on', value);
      all.classList.toggle('on', !value);
      missingBooks.el.classList.toggle('off', value);
      coverage.hidden = value;
      run();
    }
  }

  // La búsqueda solo recorre los libros descargados: se dice siempre, y si faltan se ofrece bajarlos.
  const coverage = h('p', { class: 'muted small', hidden: !!focusBook });
  let totalBooks = 0; // libros del catálogo; 0 si no se pudo consultar (sin conexión)
  async function updateCoverage() {
    let info = null;
    try {
      info = await missing();
    } catch { /* sin catálogo: se informa solo lo que hay en el teléfono */ }
    totalBooks = info?.total ?? 0;
    const have = totalBooks ? info.downloaded : books.length;
    coverage.textContent = !totalBooks ? `Solo se busca en los libros descargados en este teléfono (${have}).`
      : have < totalBooks ? `Solo se busca en los libros descargados: ${have} de ${totalBooks}.`
        : `Se busca en los ${totalBooks} libros de la biblioteca (todos están descargados).`;
  }

  const missingBooks = downloadCard({ intro: 'Descarga los libros que faltan para buscar en toda la biblioteca.' });
  missingBooks.el.classList.toggle('off', !!focusBook); // buscando en un solo libro, el aviso sobra
  updateCoverage();

  root.append(h('div', { class: 'page' },
    h('header', { class: 'head' }, h('h1', {}, 'Buscar')),
    h('form', { onsubmit: (e) => { e.preventDefault(); input.blur(); run(); } }, input),
    focusBook && scope,
    coverage,
    missingBooks.el,
    status, list, h('div', { class: 'center' }, moreBtn)),
  tabbar('search'));

  // Al terminar de descargar libros, se repite la búsqueda para incluirlos.
  const onDownloads = async () => {
    if (job.running || job.error || !job.done) return;
    await loadBooks();
    await updateCoverage();
    if (input.value) run();
  };
  db.events.addEventListener('downloads', onDownloads);

  const chapterOf = (hit) => {
    const key = `${hit.bookId}\u0000${hit.idx}`;
    if (!chapters.has(key)) chapters.set(key, db.getChapter(hit.bookId, hit.idx));
    return chapters.get(key);
  };

  function hitEl(hit, chapter) {
    const block = chapter.blocks[hit.b];
    const text = plain(block.h);
    const [first] = hit.ranges;
    const from = Math.max(0, first[0] - 90);
    const to = Math.min(text.length, first[1] + 190);
    let html = from > 0 ? '…' : '';
    let pos = from;
    for (const [s, e] of hit.ranges) {
      if (e <= from || s >= to) continue;
      const a = Math.max(s, from);
      const b = Math.min(e, to);
      html += `${stripMarkers(text.slice(pos, a))}<mark>${stripMarkers(text.slice(a, b))}</mark>`;
      pos = b;
    }
    html += stripMarkers(text.slice(pos, to)) + (to < text.length ? '…' : '');

    const page = pageNear(text, first[0], block.p);
    const a = h('a', { class: 'hit', href: `#/read/${enc(hit.bookId)}/${hit.idx}/${hit.b}?q=${enc(input.value)}` },
      h('div', { class: 'hit-ref' }, [byId.get(hit.bookId).title, chapter.title, page && `p. ${page}`].filter(Boolean).join(' · ')),
      h('div', { class: 'hit-text' }));
    a.lastChild.innerHTML = html;
    return a;
  }

  async function more(id) {
    const slice = hits.slice(shown, shown + PAGE);
    const loaded = await Promise.all(slice.map(chapterOf));
    if (id !== runId) return;
    slice.forEach((hit, i) => {
      if (hit.rank === 1 && !list.querySelector('.rank-sep') && (shown + i === 0 || hits[shown + i - 1].rank === 0)) {
        list.append(h('div', { class: 'rank-sep' }, 'Contienen todas las palabras'));
      }
      list.append(hitEl(hit, loaded[i]));
    });
    shown += slice.length;
    moreBtn.hidden = shown >= hits.length;
  }

  async function run() {
    const id = ++runId;
    const matcher = makeMatcher(input.value);
    list.replaceChildren();
    moreBtn.hidden = true;
    shown = 0;
    hits = [];

    const url = `#/search?q=${enc(input.value)}${focusBook ? `&book=${enc(focusBook)}` : ''}`;
    history.replaceState(null, '', url);

    if (!books.length) {
      status.textContent = 'Aún no tienes libros descargados. Descárgalos en la Biblioteca para poder buscar en ellos.';
      return;
    }
    if (!matcher) {
      status.textContent = 'Escribe al menos dos letras. Usa comillas para buscar una frase exacta.';
      return;
    }
    status.textContent = 'Buscando…';

    const scope = onlyBook ? focusBook : null;
    const total = await db.countSearch(scope);
    const found = [];
    let seen = 0;
    await db.scanSearch(scope, (rec) => {
      if (id !== runId) return false; // llegó una búsqueda más nueva
      for (let b = 0; b < rec.norms.length; b++) {
        const r = matchText(rec.norms[b], matcher);
        if (r) found.push({ bookId: rec.bookId, idx: rec.idx, b, rank: r.rank, ranges: r.ranges });
      }
      if (++seen % 500 === 0 && total > 1000) status.textContent = `Buscando… ${Math.round((seen * 100) / total)} %`;
    });
    if (id !== runId) return;

    found.sort((a, b) => a.rank - b.rank || (order.get(a.bookId) ?? 0) - (order.get(b.bookId) ?? 0) || a.idx - b.idx || a.b - b.b);
    hits = found;
    status.textContent = found.length
      ? `${found.length} ${found.length === 1 ? 'resultado' : 'resultados'}`
      : `Sin resultados. Prueba con menos palabras o sin acentos.${!onlyBook && totalBooks > books.length ? ' Recuerda que solo se busca en los libros descargados.' : ''}`;
    await more(id);
  }

  if (input.value) run();
  else status.textContent = 'Busca una cita por palabras o por frase exacta (entre comillas) en los libros descargados.';
  if (!input.value && !ctx.query.has('book')) queueMicrotask(() => input.focus());

  return () => {
    runId++; // detiene una búsqueda en curso
    missingBooks.dispose();
    db.events.removeEventListener('downloads', onDownloads);
  };
}
