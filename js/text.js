// Utilidades de texto: normalización para buscar, coincidencias y formato de citas.
const COMBINING = /[̀-ͯ]/g;

// Minúsculas y sin acentos, conservando la longitud: así las posiciones de una
// coincidencia en el texto normalizado valen también en el texto original.
export function norm(s) {
  const n = s.normalize('NFD').replace(COMBINING, '').toLowerCase();
  if (n.length === s.length) return n;
  let out = '';
  for (const ch of s) {
    const c = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

// Identificador estable de un libro a partir de su título (sirve igual para el catálogo y el EPUB).
export const slug = (title) => norm(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122);

function findAll(text, re) {
  re.lastIndex = 0;
  const out = [];
  for (let m; (m = re.exec(text));) {
    if (m.index === 0 || !isAlnum(text.charCodeAt(m.index - 1))) out.push([m.index, m.index + m[0].length]);
    else re.lastIndex = m.index + 1;
  }
  return out;
}

function mergeRanges(ranges) {
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

// Una búsqueda es una frase (entre comillas) o un conjunto de palabras.
// Sin comillas se intenta primero la frase completa y luego "contiene todas las palabras".
export function makeMatcher(query) {
  const phraseOnly = /["“”«»]/.test(query);
  const tokens = norm(query).match(/[a-z0-9]+/g) || [];
  if (!tokens.length || tokens.join('').length < 2) return null;
  const gap = '(?:\\[\\d+\\]|[^a-z0-9])+'; // permite saltos de página [38] dentro de la frase
  return {
    phraseOnly,
    tokens,
    phrase: new RegExp(tokens.join(gap), 'g'),
    words: tokens.map((t) => new RegExp(t, 'g')),
  };
}

// ntext debe venir de norm(). Devuelve { rank, ranges } o null.
export function matchText(ntext, m) {
  const exact = findAll(ntext, m.phrase);
  if (exact.length) return { rank: 0, ranges: exact };
  if (m.phraseOnly || m.tokens.length < 2) return null;
  const all = [];
  for (const re of m.words) {
    const r = findAll(ntext, re);
    if (!r.length) return null;
    all.push(...r);
  }
  return { rank: 1, ranges: mergeRanges(all) };
}

export const cleanQuote = (t) => t.replace(/\s*\[\d+\]\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

export function citation(texts, bookTitle, ref) {
  return `“${texts.map(cleanQuote).join('\n')}”\n— ${bookTitle}${ref ? ', ' + ref : ''}`;
}

// Un destacado que cruza varios párrafos se guarda como un registro por párrafo
// con el mismo `group`; aquí se vuelven a juntar.
export function groupHighlights(list) {
  const map = new Map();
  for (const hl of list) {
    const key = hl.group || hl.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(hl);
  }
  return [...map].map(([id, items]) => {
    items.sort((a, b) => a.chapter - b.chapter || a.block - b.block || a.start - b.start);
    return { id, items, first: items[0] };
  });
}
