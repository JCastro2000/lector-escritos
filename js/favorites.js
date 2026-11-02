// Favoritos. Cada libro guarda { on, t, s }: si es favorito, cuándo cambió y hasta cuándo está sincronizado.
// Así dos dispositivos pueden marcar libros distintos y al sincronizar no se pisan.
import { notify } from './db.js';

const KEY = 'lector.favorites';

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw?.items) return raw.items;
    if (Array.isArray(raw?.ids)) {
      // Formato anterior: solo una lista de libros.
      const now = Date.now();
      const items = Object.fromEntries(raw.ids.map((id) => [id, { on: true, t: now, s: 0 }]));
      write(items);
      return items;
    }
  } catch { /* sin datos o ilegibles */ }
  return {};
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ items }));
  } catch { /* sin almacenamiento: vale solo durante esta sesión */ }
}

export const isFav = (id) => !!read()[id]?.on;

export function toggle(id) {
  const items = read();
  items[id] = { on: !items[id]?.on, t: Date.now(), s: items[id]?.s ?? 0 };
  write(items);
  notify('favorites');
  return items[id].on;
}

// Cambios que aún no están en la nube.
export function dirty() {
  return Object.fromEntries(Object.entries(read()).filter(([, v]) => v.t > (v.s ?? 0)));
}

export function markSynced(sent) {
  const items = read();
  for (const [id, v] of Object.entries(sent)) if (items[id]) items[id].s = Math.max(items[id].s ?? 0, v.t);
  write(items);
}

// Aplica lo que llegó de la nube: gana el cambio más reciente de cada libro.
export function applyRemote(remote) {
  const items = read();
  let changed = false;
  for (const [id, r] of Object.entries(remote)) {
    if (!items[id] || r.t > items[id].t) {
      items[id] = { on: !!r.on, t: r.t, s: r.t };
      changed = true;
    }
  }
  if (changed) {
    write(items);
    notify('favorites', { remote: true });
  }
}

export function wipe() {
  write({});
  notify('favorites', { remote: true });
}
