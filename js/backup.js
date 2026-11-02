// Respaldo de destacados: exportar / importar un archivo y saber cuándo fue el último.
import * as db from './db.js';
import { saveFile, toast } from './ui.js';

const KEY = 'lector.lastBackup';
const REMIND_AFTER_DAYS = 7;

const lastBackup = () => {
  try {
    return +localStorage.getItem(KEY) || 0;
  } catch {
    return 0;
  }
};

// Cuántos destacados se crearon después del último respaldo y cuánto hace de él.
export async function backupStatus() {
  const all = await db.listHighlights();
  const last = lastBackup();
  const pending = all.filter((x) => x.created > last).length;
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  return { total: all.length, pending, last, days, due: pending > 0 && (days === null || days >= REMIND_AFTER_DAYS) };
}

export function describeLast({ last, days }) {
  if (!last) return 'Aún no has hecho ningún respaldo.';
  if (days === 0) return 'Último respaldo: hoy.';
  return `Último respaldo: hace ${days} ${days === 1 ? 'día' : 'días'}.`;
}

// En el teléfono abre la hoja de compartir (se puede guardar en Archivos / iCloud / Drive).
export async function exportHighlights() {
  const all = await db.listHighlights();
  if (!all.length) {
    toast('Aún no tienes destacados');
    return false;
  }
  const data = JSON.stringify({ app: 'lector-escritos', version: 1, exported: new Date().toISOString(), highlights: all }, null, 1);
  const done = await saveFile(`destacados-${new Date().toISOString().slice(0, 10)}.json`, new Blob([data], { type: 'application/json' }));
  if (done) {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch { /* sin almacenamiento: no se recuerda la fecha */ }
  }
  return done;
}

export async function importHighlights(file) {
  try {
    const data = JSON.parse(await file.text());
    const valid = (data.highlights ?? []).filter((x) => x?.id && x.bookId && Number.isInteger(x.start) && Number.isInteger(x.end) && x.text);
    if (!valid.length) throw new Error('vacío');
    await db.putHighlights(valid);
    toast(`${valid.length} destacados importados`);
    return valid.length;
  } catch {
    toast('El archivo no es un respaldo válido', 4000);
    return 0;
  }
}
