// Almacenamiento local (IndexedDB): libros, capítulos, índice de búsqueda y destacados.
import { norm } from './text.js';

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

export async function updateBook(id, patch) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  const store = tx.objectStore('books');
  store.get(id).onsuccess = (e) => {
    if (e.target.result) store.put({ ...e.target.result, ...patch });
  };
  return complete(tx);
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
  return book;
}

// Quita el libro del dispositivo. Los destacados se conservan.
export async function deleteBook(id) {
  const db = await open();
  const tx = db.transaction(['books', 'chapters', 'search'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('chapters').delete(bookRange(id));
  tx.objectStore('search').delete(bookRange(id));
  return complete(tx);
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

export async function listHighlights(bookId) {
  const db = await open();
  const store = db.transaction('highlights').objectStore('highlights');
  return request(bookId ? store.index('bookId').getAll(bookId) : store.getAll());
}

export async function putHighlights(list) {
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  list.forEach((h) => tx.objectStore('highlights').put(h));
  return complete(tx);
}

export async function deleteHighlights(ids) {
  const db = await open();
  const tx = db.transaction('highlights', 'readwrite');
  ids.forEach((id) => tx.objectStore('highlights').delete(id));
  return complete(tx);
}
