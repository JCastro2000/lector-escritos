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

let opening;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const rq = indexedDB.open('lector-escritos', 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('chapters', { keyPath: ['bookId', 'idx'] });
      db.createObjectStore('search', { keyPath: ['bookId', 'idx'] }).createIndex('bookId', 'bookId');
      db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId');
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
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

export async function getChapter(bookId, idx) {
  const db = await open();
  return request(db.transaction('chapters').objectStore('chapters').get([bookId, idx]));
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
  const db = await open();
  const tx = db.transaction(['books', 'chapters', 'search'], 'readwrite');
  const range = bookRange(meta.id);
  tx.objectStore('chapters').delete(range);
  tx.objectStore('search').delete(range);
  tx.objectStore('books').put(book);
  chapters.forEach((c, idx) => {
    tx.objectStore('chapters').put({
      bookId: meta.id,
      idx,
      title: c.title,
      blocks: c.blocks.map((b) => ({ t: b.tag, c: b.cls, h: b.html, p: b.page })),
    });
    tx.objectStore('search').put({ bookId: meta.id, idx, norms: c.blocks.map((b) => norm(b.text)) });
  });
  await complete(tx);
  notify('books');
  return book;
}

// Quita el libro del dispositivo. Los destacados se conservan.
export async function deleteBook(id) {
  const db = await open();
  const tx = db.transaction(['books', 'chapters', 'search'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('chapters').delete(bookRange(id));
  tx.objectStore('search').delete(bookRange(id));
  await complete(tx);
  notify('books');
}

// Recorre el índice de búsqueda (de un libro o de todos), un capítulo por vez.
export async function scanSearch(bookId, visit) {
  const db = await open();
  const store = db.transaction('search').objectStore('search');
  const cursor = bookId ? store.index('bookId').openCursor(IDBKeyRange.only(bookId)) : store.openCursor();
  await new Promise((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve();
      visit(c.value);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
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
