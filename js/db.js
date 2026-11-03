// Almacenamiento local (IndexedDB): libros, capítulos, índice de búsqueda y destacados.
//
// Los destacados llevan `updated` (última modificación) y `deleted` (los borrados se conservan como
// "lápidas" para poder sincronizarlos con otros dispositivos) y `syncedAt` (hasta qué `updated`
// ya está en la nube). Un destacado está pendiente de subir si updated > syncedAt.
import { norm } from './text.js';

// Avisos internos: 'books', 'highlights', 'favorites' y 'sync'. detail.remote = true si el cambio vino de la nube.
export const events = new EventTarget();
export const notify = (type, detail = {}) => events.dispatchEvent(new CustomEvent(type, { detail }));

export const stamp = (h) => h.updated ?? h.created ?? 0;

// Versión 2: el texto y el índice de búsqueda se guardan comprimidos, un registro por libro
// (stores `text` e `index`). Los stores `chapters` y `search` de la versión 1 solo quedan en
// dispositivos que ya tenían libros: `migrate` los vacía.
let opening;
function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const rq = indexedDB.open('lector-escritos', 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        const has = (name) => db.objectStoreNames.contains(name);
        if (!has('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!has('highlights')) db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        if (!has('text')) db.createObjectStore('text', { keyPath: 'bookId' });
        if (!has('index')) db.createObjectStore('index', { keyPath: 'bookId' });
      };
      rq.onsuccess = () => {
        rq.result.onversionchange = () => rq.result.close();
        resolve(rq.result);
      };
      rq.onerror = () => reject(rq.error);
    });
    opening.then(ready).catch(() => {});
  }
  return opening;
}

const request = (rq) => new Promise((resolve, reject) => {
  rq.onsuccess = () => resolve(rq.result);
  rq.onerror = () => reject(rq.error);
});

const complete = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error);
});

const bookRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

export async function listBooks() {
  const db = await open();
  return request(db.transaction('books').objectStore('books').getAll());
}

export async function getBook(id) {
  const db = await open();
  return request(db.transaction('books').objectStore('books').get(id));
}

// ---------- Texto e índice comprimidos (gzip, un registro por libro) ----------

const through = (data, stream) => new Response(new Blob([data]).stream().pipeThrough(stream));
const pack = async (text) => new Uint8Array(await through(text, new CompressionStream('gzip')).arrayBuffer());
const unpack = (bytes) => through(bytes, new DecompressionStream('gzip')).text();

// Los párrafos del índice se separan con \n y los capítulos con \u0001 (se cambian por espacio
// dentro del texto, lo que no altera longitudes ni búsquedas).
const joinNorms = (chapters) => chapters
  .map((norms) => norms.map((s) => s.replace(/[\n\u0001]/g, ' ')).join('\n'))
  .join('\u0001');
const splitNorms = (s) => s.split('\u0001').map((c) => c.split('\n'));

// chapters: [{ title, blocks }]; norms: un arreglo de textos normalizados por capítulo.
async function packBook(bookId, chapters, norms) {
  const [text, index] = await Promise.all([pack(JSON.stringify(chapters)), pack(joinNorms(norms))]);
  return { text: { bookId, data: text }, index: { bookId, data: index } };
}

// El capítulo se saca del libro descomprimido; se guardan los últimos en memoria.
const texts = new Map();
function bookText(bookId) {
  if (!texts.has(bookId)) {
    const load = (async () => {
      await ready();
      const db = await open();
      const rec = await request(db.transaction('text').objectStore('text').get(bookId));
      return rec ? JSON.parse(await unpack(rec.data)) : null;
    })();
    texts.set(bookId, load);
    load.then((chapters) => !chapters && texts.delete(bookId), () => texts.delete(bookId));
    if (texts.size > 4) texts.delete(texts.keys().next().value);
  }
  return texts.get(bookId);
}

export async function getChapter(bookId, idx) {
  const chapter = (await bookText(bookId))?.[idx];
  return chapter && { bookId, idx, title: chapter.title, blocks: chapter.blocks };
}

// Pasa los libros de la versión 1 (un registro por capítulo, sin comprimir) al formato nuevo.
// Va de a un libro y cada uno es atómico: si se interrumpe, continúa en la próxima apertura.
let migration;
const ready = () => (migration ??= migrate().catch((e) => console.error('migración', e)));

async function migrate() {
  const db = await open();
  if (!db.objectStoreNames.contains('chapters')) return;
  const keys = await request(db.transaction('chapters').objectStore('chapters').getAllKeys());
  const ids = [...new Set(keys.map(([id]) => id))];
  if (!ids.length) return;
  notify('migrating', { total: ids.length });
  for (const id of ids) {
    const read = db.transaction(['chapters', 'search']);
    const [chapters, searches] = await Promise.all([
      request(read.objectStore('chapters').getAll(bookRange(id))),
      request(read.objectStore('search').getAll(bookRange(id))),
    ]);
    if (!chapters.length || !searches.length) continue; // otra pestaña ya lo migró
    chapters.sort((a, b) => a.idx - b.idx);
    searches.sort((a, b) => a.idx - b.idx);
    const { text, index } = await packBook(
      id,
      chapters.map((c) => ({ title: c.title, blocks: c.blocks })),
      searches.map((s) => s.norms),
    );
    const write = db.transaction(['text', 'index', 'chapters', 'search'], 'readwrite');
    write.objectStore('text').put(text);
    write.objectStore('index').put(index);
    write.objectStore('chapters').delete(bookRange(id));
    write.objectStore('search').delete(bookRange(id));
    await complete(write);
  }
  notify('migrated');
}

// silent: no avisa del cambio (lo usa la sincronización para no volver a dispararse a sí misma).
export async function updateBook(id, patch, { silent = false } = {}) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  const store = tx.objectStore('books');
  store.get(id).onsuccess = (e) => {
    if (e.target.result) store.put({ ...e.target.result, ...patch });
  };
  await complete(tx);
  if (!silent) notify('books');
}

// Guarda (o reemplaza) un libro ya procesado por parseEpub.
export async function saveBook({ meta, cover, chapters }) {
  const prev = await getBook(meta.id);
  const book = {
    ...meta,
    cover,
    toc: chapters.map((c) => c.title),
    added: prev?.added ?? Date.now(),
    lastRead: prev?.lastRead ?? 0,
    pos: prev?.pos ?? null,
    posSynced: prev?.posSynced ?? 0,
  };
  const { text, index } = await packBook(
    meta.id,
    chapters.map((c) => ({ title: c.title, blocks: c.blocks.map((b) => ({ t: b.tag, c: b.cls, h: b.html, p: b.page })) })),
    chapters.map((c) => c.blocks.map((b) => norm(b.text))),
  );
  await ready();
  const db = await open();
  const tx = db.transaction(['books', 'text', 'index'], 'readwrite');
  tx.objectStore('books').put(book);
  tx.objectStore('text').put(text);
  tx.objectStore('index').put(index);
  await complete(tx);
  texts.delete(meta.id);
  notify('books');
  return book;
}

// Quita el libro del dispositivo. Los destacados se conservan.
export async function deleteBook(id) {
  await ready();
  const db = await open();
  const tx = db.transaction(['books', 'text', 'index'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('text').delete(id);
  tx.objectStore('index').delete(id);
  await complete(tx);
  texts.delete(id);
  notify('books');
}

// Cuántos capítulos hay en el índice de búsqueda (de un libro o de todos).
export async function countSearch(bookId) {
  const books = bookId ? [await getBook(bookId)] : await listBooks();
  return books.reduce((sum, b) => sum + (b?.toc.length ?? 0), 0);
}

// Recorre el índice de búsqueda (de un libro o de todos), un capítulo por vez.
// Si `visit` devuelve false, se detiene (por ejemplo, porque ya hay otra búsqueda más nueva).
export async function scanSearch(bookId, visit) {
  await ready();
  const db = await open();
  const ids = bookId ? [bookId] : await request(db.transaction('index').objectStore('index').getAllKeys());
  const load = (id) => request(db.transaction('index').objectStore('index').get(id));
  let next = ids.length ? load(ids[0]) : null;
  for (let i = 0; i < ids.length; i++) {
    const rec = await next;
    next = i + 1 < ids.length ? load(ids[i + 1]) : null; // lee el siguiente mientras se descomprime éste
    if (!rec) continue;
    const chapters = splitNorms(await unpack(rec.data));
    for (let idx = 0; idx < chapters.length; idx++) {
      if (visit({ bookId: rec.bookId, idx, norms: chapters[idx] }) === false) return;
    }
  }
}

// ---------- Destacados ----------

// Todos, incluidos los borrados (lo que necesita la sincronización).
export async function rawHighlights() {
  const db = await open();
  return request(db.transaction('highlights').objectStore('highlights').getAll());
}

export async function listHighlights(bookId) {
  const db = await open();
  const store = db.transaction('highlights').objectStore('highlights');
  const all = await request(bookId ? store.index('bookId').getAll(bookId) : store.getAll());
  return all.filter((h) => !h.deleted);
}

export async function putHighlights(list) {
  const now = Date.now();
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  list.forEach((h) => tx.objectStore('highlights').put({ ...h, updated: now, deleted: false }));
  await complete(tx);
  notify('highlights');
}

export async function deleteHighlights(ids) {
  const now = Date.now();
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  const store = tx.objectStore('highlights');
  ids.forEach((id) => {
    store.get(id).onsuccess = (e) => {
      if (e.target.result) store.put({ ...e.target.result, deleted: true, updated: now });
    };
  });
  await complete(tx);
  notify('highlights');
}

// Aplica lo que llegó de la nube: gana el cambio más reciente.
export async function applyRemoteHighlights(list) {
  if (!list.length) return;
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  const store = tx.objectStore('highlights');
  let changed = false;
  for (const remote of list) {
    store.get(remote.id).onsuccess = (e) => {
      const local = e.target.result;
      const rt = stamp(remote);
      if (!local || rt > stamp(local)) {
        store.put({ ...remote, syncedAt: rt });
        changed = true;
      } else if (rt === stamp(local) && (local.syncedAt ?? 0) < rt) {
        store.put({ ...local, syncedAt: rt });
      }
    };
  }
  await complete(tx);
  if (changed) notify('highlights', { remote: true });
}

export async function markHighlightsSynced(pairs) {
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  const store = tx.objectStore('highlights');
  pairs.forEach(({ id, updated }) => {
    store.get(id).onsuccess = (e) => {
      const local = e.target.result;
      if (local) store.put({ ...local, syncedAt: Math.max(local.syncedAt ?? 0, updated) });
    };
  });
  await complete(tx);
}

// Borra lo que pertenece a una cuenta (destacados y posiciones de lectura) al cambiar de cuenta.
export async function wipeUserData() {
  const db = await open();
  const tx = db.transaction(['highlights', 'books'], 'readwrite');
  tx.objectStore('highlights').clear();
  const books = tx.objectStore('books');
  books.openCursor().onsuccess = (e) => {
    const c = e.target.result;
    if (!c) return;
    c.update({ ...c.value, pos: null, lastRead: 0, posSynced: 0 });
    c.continue();
  };
  await complete(tx);
  notify('highlights', { remote: true });
  notify('books', { remote: true });
}
