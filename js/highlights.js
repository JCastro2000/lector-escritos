// Lista de destacados de todos los libros, con respaldo (exportar / importar).
import * as db from './db.js';
import { h, icon, toast, tabbar, copyText, shareText, saveFile, confirmAction } from './ui.js';
import { citation, groupHighlights, norm } from './text.js';

const enc = encodeURIComponent;
const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });

export async function mount(root) {
  let all = await db.listHighlights();
  const present = new Set((await db.listBooks()).map((b) => b.id));
  let filter = '';

  const listEl = h('div', { class: 'hl-list' });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importBackup });
  const count = h('span', { class: 'muted' });

  root.append(h('div', { class: 'page' },
    h('header', { class: 'head' }, h('h1', {}, 'Destacados'), count),
    h('input', {
      type: 'search', class: 'searchbox', placeholder: 'Buscar en mis destacados…', 'aria-label': 'Buscar en mis destacados',
      oninput: (e) => { filter = norm(e.target.value); render(); },
    }),
    listEl,
    h('section', { class: 'card' },
      h('h2', {}, 'Respaldo'),
      h('p', { class: 'muted' }, 'Tus destacados viven en este dispositivo. Guarda un respaldo para pasarlos a otro teléfono o recuperarlos si borras los datos del navegador.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportBackup }, icon('download', 18), 'Exportar'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Importar')))),
  fileInput,
  tabbar('highlights'));

  async function exportBackup() {
    if (!all.length) return toast('Aún no tienes destacados');
    const data = JSON.stringify({ app: 'lector-escritos', version: 1, exported: new Date().toISOString(), highlights: all }, null, 1);
    await saveFile(`destacados-${new Date().toISOString().slice(0, 10)}.json`, new Blob([data], { type: 'application/json' }));
  }

  async function importBackup() {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const valid = (data.highlights ?? []).filter((x) => x?.id && x.bookId && Number.isInteger(x.start) && Number.isInteger(x.end) && x.text);
      if (!valid.length) throw new Error('vacío');
      await db.putHighlights(valid);
      all = await db.listHighlights();
      render();
      toast(`${valid.length} destacados importados`);
    } catch {
      toast('El archivo no es un respaldo válido', 4000);
    }
  }

  function card(g) {
    const first = g.first;
    const quote = g.items.map((i) => i.text);
    const open = present.has(first.bookId);
    return h('article', { class: `hl-card hl-edge-${first.color}` },
      h('blockquote', {}, quote.map((t) => h('p', {}, t.replace(/\s*\[\d+\]\s*/g, ' ')))),
      h('div', { class: 'muted small' }, [first.chapterTitle, first.ref, dateFmt.format(first.created)].filter(Boolean).join(' · ')),
      h('div', { class: 'row actions' },
        open
          ? h('a', { class: 'btn small', href: `#/read/${enc(first.bookId)}/${first.chapter}/${first.block}` }, 'Ir al texto')
          : h('span', { class: 'muted small' }, 'Libro no descargado'),
        h('button', { class: 'iconbtn', 'aria-label': 'Copiar', onclick: () => copyText(citation(quote, first.bookTitle, first.ref)) }, icon('copy', 20)),
        navigator.share && h('button', { class: 'iconbtn', 'aria-label': 'Compartir', onclick: () => shareText(citation(quote, first.bookTitle, first.ref)) }, icon('share', 20)),
        h('button', {
          class: 'iconbtn', 'aria-label': 'Eliminar',
          onclick: async () => {
            if (!(await confirmAction('¿Eliminar este destacado?', 'No se puede deshacer.'))) return;
            await db.deleteHighlights(g.items.map((i) => i.id));
            all = all.filter((x) => !g.items.includes(x));
            render();
          },
        }, icon('trash', 20))));
  }

  function render() {
    listEl.replaceChildren();
    const groups = groupHighlights(all)
      .filter((g) => !filter || norm(`${g.first.bookTitle} ${g.items.map((i) => i.text).join(' ')}`).includes(filter));
    count.textContent = all.length ? `${groupHighlights(all).length}` : '';

    if (!groups.length) {
      listEl.append(h('div', { class: 'empty' },
        icon('bookmark', 44),
        h('h2', {}, all.length ? 'Sin coincidencias' : 'Aún no hay destacados'),
        !all.length && h('p', {}, 'Mientras lees, mantén presionado un texto, selecciónalo y elige un color. Quedará guardado aquí.')));
      return;
    }

    const byBook = new Map();
    for (const g of groups) {
      if (!byBook.has(g.first.bookTitle)) byBook.set(g.first.bookTitle, []);
      byBook.get(g.first.bookTitle).push(g);
    }
    for (const title of [...byBook.keys()].sort((a, b) => a.localeCompare(b, 'es'))) {
      const items = byBook.get(title).sort((a, b) => a.first.chapter - b.first.chapter || a.first.block - b.first.block);
      listEl.append(h('h2', { class: 'hl-book' }, title), ...items.map(card));
    }
  }

  render();
}
