// Clasificación de libros por categoría y catálogo opcional de libros descargables.
import { norm } from './text.js';

export const CATEGORY_ORDER = [
  'Historia de la redención',
  'Vida cristiana',
  'Testimonios y consejos',
  'Salud, hogar y educación',
  'Devocionales',
  'Otros libros',
];

// Se evalúan en orden con el título sin acentos. Para mover un libro concreto basta
// poner "category" en library/books.json; eso tiene prioridad sobre estas reglas.
const RULES = [
  ['Historia de la redención', /patriarcas|profetas y reyes|deseado de todas|hechos de los apostoles|conflicto de los siglos|primeros escritos|historia de la redencion|dones espirituales|eventos de los ultimos/],
  ['Devocionales', /mi vida hoy|a fin de conocerle|reflejemos a jesus|maranata|hijos e hijas|alza tus ojos|cada dia con dios|meditaciones matinales|dios nos cuida|nuestra elevada vocacion|en los lugares celestiales/],
  ['Salud, hogar y educación', /ministerio de curacion|consejos sobre (la salud|el regimen|nutricion)|regimen alimenticio|la educacion|educacion cristiana|conduccion del nino|hogar cristiano|temperancia|consejos para los (maestros|padres)|mensajes para los jovenes/],
  ['Testimonios y consejos', /testimonios|consejos|mensajes selectos|joyas|obreros evangelicos|servicio cristiano|evangelismo|iglesia remanente|notas biograficas/],
  ['Vida cristiana', /camino a cristo|palabras de vida|discurso maestro|pensamientos del monte|el otro poder|mente,? caracter|la fe por la cual|recibireis poder|parabolas|cristo triunfante|el ministerio de la bondad|vida cristiana|el camino/],
];

export function categoryOf(title) {
  const t = norm(title);
  return RULES.find(([, re]) => re.test(t))?.[0] ?? 'Otros libros';
}

// Si publicas libros junto a la app, lista aquí lo que se puede descargar:
// library/books.json -> [{ "title": "El Camino a Cristo", "file": "camino-a-cristo.epub" }, ...]
export async function loadRemote() {
  try {
    const res = await fetch('library/books.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter((b) => b?.title && b?.file) : [];
  } catch {
    return [];
  }
}
