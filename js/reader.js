// Lector: un capítulo por vez, posición guardada, destacados y citas.
import * as db from './db.js';
import { h, icon, toast, openSheet, confirmAction, uid, copyText, shareText, COLORS, COLOR_NAMES } from './ui.js';
import { makeMatcher, matchText, norm, citation, cleanQuote, groupHighlights } from './text.js';
import { settingsPanel } from './settings.js';

const enc = encodeURIComponent;

// Posición (en caracteres) de un punto del DOM dentro del texto de un bloque.
function offsetIn(el, node, off) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, off);
  return r.toString().length;
}

// Página a la que pertenece la posición `off` del bloque.
function pageAt(el, off) {
  let page = +el.dataset.page;
  for (const m of el.querySelectorAll('.pagebreak')) {
    const n = /^\[(\d+)\]$/.exec(m.textContent);
    if (!n) continue;
    if (offsetIn(el, m, 0) <= off) page = +n[1];
    else break;
  }
  return page;
}

// Envuelve el rango [start, end) del texto de `root` en <mark>.
function wrapRange(root, start, end, className, dataset = {}) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans = [];
  let pos = 0;
  for (let n; (n = walker.nextNode());) {
    const len = n.nodeValue.length;
    if (pos < end && pos + len > start) spans.push([n, Math.max(start - pos, 0), Math.min(end - pos, len)]);
    pos += len;
  }
  for (const [node, s, e] of spans) {
    const range = document.createRange();
    range.setStart(node, s);
    range.setEnd(node, e);
    const mark = document.createElement('mark');
    mark.className = className;
    Object.assign(mark.dataset, dataset);
    range.surroundContents(mark);
  }
}

const blockHtml = (b, i) =>
  `<${b.t} class="${b.c.replace(/"/g, '')}" data-b="${i}" data-page="${b.p}">${b.h}</${b.t}>`;

export async function mount(root, ctx) {
  const book = await db.getBook(decodeURIComponent(ctx.args[0] ?? ''));
  if (!book) {
    root.append(h('div', { class: 'page empty' },
      h('h2', {}, 'Libro no encontrado'),
      h('p', {}, 'No está descargado en este dispositivo.'),
      h('a', { class: 'btn primary', href: '#/' }, 'Ir a la biblioteca')));
    return;
  }

  let hls = await db.listHighlights(book.id);
  const query = ctx.query.get('q');
  const matcher = query ? makeMatcher(query) : null;
  const finds = new Map(); // bloque -> rangos de la búsqueda que se muestran resaltados

  let chapterIdx = 0;
  let chapter = null;
  let blockIdx = 0;
  let sel = null; // { kind: 'new', parts, ref } | { kind: 'hl', group }

  // ---------- Estructura ----------
  const chapterEl = h('div', { class: 'rchapter' });
  const textEl = h('article', { class: 'rtext', lang: 'es' });
  const progress = h('div', { class: 'rprogress' });
  const footLabel = h('div', { class: 'rfoot-label' });
  const prevBtn = h('button', { class: 'iconbtn', 'aria-label': 'Capítulo anterior', onclick: () => go(chapterIdx - 1) }, icon('left'));
  const nextBtn = h('button', { class: 'iconbtn', 'aria-label': 'Capítulo siguiente', onclick: () => go(chapterIdx + 1) }, icon('right'));

  const bar = h('header', { class: 'rbar' },
    h('button', { class: 'iconbtn', 'aria-label': 'Biblioteca', onclick: () => { location.hash = '#/'; } }, icon('back')),
    h('div', { class: 'rtitles' }, h('div', { class: 'rbook' }, book.title), chapterEl),
    h('button', { class: 'iconbtn', 'aria-label': 'Buscar en este libro', onclick: () => { location.hash = `#/search?book=${enc(book.id)}`; } }, icon('search')),
    h('button', { class: 'iconbtn', 'aria-label': 'Capítulos y destacados', onclick: openContents }, icon('list')),
    h('button', { class: 'iconbtn', 'aria-label': 'Apariencia', onclick: () => openSheet('Apariencia', settingsPanel()) }, icon('type')));

  const foot = h('footer', { class: 'rfoot' }, progress, prevBtn, footLabel, nextBtn);

  const selbar = h('div', { class: 'selbar', hidden: true },
    h('div', { class: 'dots' }, COLORS.map((c) =>
      h('button', { class: `dot dot-${c}`, 'aria-label': `Destacar en ${COLOR_NAMES[c].toLowerCase()}`, onclick: () => applyColor(c) }))),
    h('button', { class: 'iconbtn', 'aria-label': 'Copiar cita', onclick: () => copyText(currentCitation()) }, icon('copy')),
    navigator.share && h('button', { class: 'iconbtn', 'aria-label': 'Compartir cita', onclick: () => shareText(currentCitation()) }, icon('share')),
    h('button', { class: 'iconbtn only-existing', 'aria-label': 'Quitar destacado', onclick: removeHighlight }, icon('trash')),
    h('button', { class: 'iconbtn', 'aria-label': 'Cerrar', onclick: hideBar }, icon('close')));

  const wrapper = h('div', { class: 'reader' }, bar, textEl, foot, selbar);
  root.append(wrapper);

  // ---------- Capítulos ----------
  function paintBlock(i) {
    const el = textEl.querySelector(`[data-b="${i}"]`);
    if (!el) return;
    el.innerHTML = chapter.blocks[i].h;
    for (const hl of hls) {
      if (hl.chapter === chapterIdx && hl.block === i) wrapRange(el, hl.start, hl.end, `hl hl-${hl.color}`, { h: hl.id });
    }
    for (const [s, e] of finds.get(i) ?? []) wrapRange(el, s, e, 'find');
  }

  async function show(idx, block = 0) {
    const next = await db.getChapter(book.id, idx);
    if (!next) return;
    hideBar();
    chapter = next;
    chapterIdx = idx;
    blockIdx = block;
    finds.clear();

    textEl.innerHTML = chapter.blocks.map(blockHtml).join('')
      + (idx < book.toc.length - 1
        ? '<button class="chapter-end btn primary" data-next>Siguiente capítulo</button>'
        : '<p class="the-end">Fin del libro</p>');
    for (const hl of hls) if (hl.chapter === idx) paintBlock(hl.block);

    const target = textEl.querySelector(`[data-b="${block}"]`);
    if (matcher && target) {
      const m = matchText(norm(target.textContent), matcher);
      if (m) {
        finds.set(block, m.ranges);
        paintBlock(block);
      }
      textEl.querySelector(`[data-b="${block}"]`).classList.add('flash');
    }

    chapterEl.textContent = chapter.title;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx >= book.toc.length - 1;
    history.replaceState(null, '', `#/read/${enc(book.id)}/${idx}/${block}`);
    if (block) textEl.querySelector(`[data-b="${block}"]`)?.scrollIntoView();
    else window.scrollTo(0, 0);
    updateMeta();
    queueSave();
  }

  function go(idx) {
    if (idx < 0 || idx >= book.toc.length) return;
    show(idx, 0);
  }

  // ---------- Posición y progreso ----------
  const barHeight = () => bar.getBoundingClientRect().height;

  function updateMeta() {
    const top = barHeight() + 8;
    let page = 0;
    for (const el of textEl.children) {
      if (el.dataset.b != null && el.getBoundingClientRect().bottom > top) {
        blockIdx = +el.dataset.b;
        page = +el.dataset.page;
        break;
      }
    }
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 1})`;
    footLabel.textContent = `Cap. ${chapterIdx + 1} de ${book.toc.length}${page ? ` · p. ${page}` : ''}`;
  }

  let saveTimer;
  function flush() {
    clearTimeout(saveTimer);
    if (chapter) db.updateBook(book.id, { pos: { c: chapterIdx, b: blockIdx }, lastRead: Date.now() });
  }
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updateMeta();
      queueSave();
    });
  };
  const onVisibility = () => document.visibilityState === 'hidden' && flush();
  const onKey = (e) => {
    if (e.key === 'ArrowRight') go(chapterIdx + 1);
    else if (e.key === 'ArrowLeft') go(chapterIdx - 1);
  };

  // ---------- Selección y destacados ----------
  function readSelection() {
    const s = getSelection();
    if (!s || !s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    if (!textEl.contains(r.commonAncestorContainer)) return null;
    const parts = [];
    for (const el of textEl.querySelectorAll('[data-b]')) {
      if (!r.intersectsNode(el)) continue;
      const full = el.textContent;
      let lo = el.contains(r.startContainer) ? offsetIn(el, r.startContainer, r.startOffset) : 0;
      let hi = el.contains(r.endContainer) ? offsetIn(el, r.endContainer, r.endOffset) : full.length;
      while (lo < hi && /\s/.test(full[lo])) lo++;
      while (hi > lo && /\s/.test(full[hi - 1])) hi--;
      if (hi > lo) parts.push({ el, b: +el.dataset.b, start: lo, end: hi, text: full.slice(lo, hi) });
    }
    if (!parts.length) return null;
    const first = parts[0];
    const last = parts.at(-1);
    const p1 = pageAt(first.el, first.start);
    const p2 = pageAt(last.el, last.end - 1);
    const ref = p1 ? (p2 > p1 ? `p. ${p1}–${p2}` : `p. ${p1}`) : '';
    return { kind: 'new', parts, ref };
  }

  const groupItems = (group) => hls.filter((x) => (x.group || x.id) === group);

  function showBar(s) {
    sel = s;
    selbar.hidden = false;
    selbar.classList.toggle('existing', s.kind === 'hl');
  }

  function hideBar() {
    sel = null;
    selbar.hidden = true;
  }

  function currentCitation() {
    if (sel?.kind === 'new') return citation(sel.parts.map((p) => p.text), book.title, sel.ref);
    const items = groupItems(sel.group);
    return citation(items.map((i) => i.text), book.title, items[0]?.ref);
  }

  async function applyColor(color) {
    if (!sel) return;
    if (sel.kind === 'new') {
      const group = uid();
      const created = Date.now();
      const records = sel.parts.map((p) => ({
        id: uid(), group, bookId: book.id, bookTitle: book.title,
        chapter: chapterIdx, chapterTitle: chapter.title, block: p.b,
        start: p.start, end: p.end, text: p.text, ref: sel.ref, color, created,
      }));
      await db.putHighlights(records);
      hls.push(...records);
      getSelection().removeAllRanges();
      records.forEach((r) => paintBlock(r.block));
      toast('Destacado guardado');
    } else {
      const items = groupItems(sel.group);
      items.forEach((x) => { x.color = color; });
      await db.putHighlights(items);
      items.filter((x) => x.chapter === chapterIdx).forEach((x) => paintBlock(x.block));
    }
    hideBar();
  }

  async function removeHighlight() {
    if (sel?.kind !== 'hl') return;
    const items = groupItems(sel.group);
    if (!(await confirmAction('¿Quitar este destacado?', 'Se borrará de este libro y de tu lista de destacados.', 'Quitar'))) return;
    await db.deleteHighlights(items.map((x) => x.id));
    hls = hls.filter((x) => !items.includes(x));
    items.filter((x) => x.chapter === chapterIdx).forEach((x) => paintBlock(x.block));
    hideBar();
    toast('Destacado eliminado');
  }

  let selTimer;
  const onSelectionChange = () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const s = readSelection();
      if (s) showBar(s);
      else if (sel?.kind === 'new') hideBar();
    }, 250);
  };

  textEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) return go(chapterIdx + 1);
    if (!getSelection().isCollapsed) return;
    const mark = e.target.closest('mark[data-h]');
    if (mark) {
      const hl = hls.find((x) => x.id === mark.dataset.h);
      if (hl) showBar({ kind: 'hl', group: hl.group || hl.id });
    } else if (sel) {
      hideBar();
    } else {
      wrapper.classList.toggle('hide-chrome');
    }
  });

  // ---------- Contenido (capítulos y destacados del libro) ----------
  function openContents() {
    const chapters = h('ol', { class: 'toc' }, book.toc.map((title, i) =>
      h('li', {}, h('button', { class: i === chapterIdx ? 'on' : '', onclick: () => { sheet.close(); go(i); } }, title))));

    const groups = groupHighlights(hls).sort((a, b) => a.first.chapter - b.first.chapter || a.first.block - b.first.block);
    const marks = groups.length
      ? h('ul', { class: 'quote-list' }, groups.map((g) =>
        h('li', {}, h('button', {
          class: `quote hl-edge-${g.first.color}`,
          onclick: () => { sheet.close(); show(g.first.chapter, g.first.block); },
        }, h('span', { class: 'quote-text' }, cleanQuote(g.items.map((i) => i.text).join(' '))),
        h('span', { class: 'muted small' }, [g.first.chapterTitle, g.first.ref].filter(Boolean).join(' · '))))))
      : h('p', { class: 'muted' }, 'Aún no has destacado nada en este libro. Selecciona un texto mientras lees.');

    const tabs = h('div', { class: 'segmented' });
    const panes = h('div', {}, chapters);
    const pick = (name, btn) => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      panes.replaceChildren(name === 'chapters' ? chapters : marks);
    };
    const b1 = h('button', { class: 'on', onclick: () => pick('chapters', b1) }, 'Capítulos');
    const b2 = h('button', { onclick: () => pick('marks', b2) }, `Destacados (${groups.length})`);
    tabs.append(b1, b2);

    const sheet = openSheet(book.title, h('div', {}, tabs, panes));
    chapters.querySelector('.on')?.scrollIntoView({ block: 'center' });
  }

  // ---------- Arranque ----------
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('selectionchange', onSelectionChange);
  addEventListener('keydown', onKey);

  const saved = book.pos;
  const startChapter = ctx.args[1] != null ? +ctx.args[1] : saved?.c ?? 0;
  const startBlock = ctx.args[2] != null ? +ctx.args[2] : ctx.args[1] != null ? 0 : saved?.b ?? 0;
  await show(Math.min(Math.max(startChapter || 0, 0), book.toc.length - 1), startBlock || 0);

  return () => {
    flush();
    removeEventListener('scroll', onScroll);
    removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('selectionchange', onSelectionChange);
    removeEventListener('keydown', onKey);
  };
}
