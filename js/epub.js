// Convierte un EPUB en { meta, cover, chapters }, con el texto ya limpio y dividido en bloques
// (párrafos, títulos). Cada bloque conserva su HTML en línea (cursivas, citas bíblicas,
// marcadores de página) y la página en la que empieza.
import { readZip } from './zip.js';
import { slug } from './text.js';

const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li';
const INLINE_OK = new Set(['EM', 'I', 'B', 'STRONG', 'SPAN', 'SUP', 'SUB', 'BR', 'U', 'SMALL', 'CITE', 'Q', 'ABBR']);
const SKIP_FILE = /^(cover|toc|titlepage|nav)\b/i;

const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const byName = (root, name) => [...root.getElementsByTagNameNS('*', name)];

function resolve(dir, href) {
  return decodeURIComponent(new URL(href, 'http://x/' + dir).pathname.slice(1));
}

// Deja solo etiquetas y atributos inofensivos; sin enlaces, scripts ni estilos.
function sanitize(el) {
  for (const n of [...el.querySelectorAll('*')]) {
    if (!INLINE_OK.has(n.tagName)) n.replaceWith(...n.childNodes);
  }
  for (const n of el.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (!(a.name === 'class' || (a.name === 'title' && n.tagName === 'SPAN'))) n.removeAttribute(a.name);
    }
  }
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n; (n = walker.nextNode());) texts.push(n);
  for (const t of texts) t.nodeValue = t.nodeValue.replace(/\s+/g, ' ').normalize('NFC');
  if (texts.length) {
    texts[0].nodeValue = texts[0].nodeValue.trimStart();
    texts.at(-1).nodeValue = texts.at(-1).nodeValue.trimEnd();
  }
}

function extractBlocks(xhtml, state) {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');
  doc.querySelectorAll('script,style,svg,img,link,head').forEach((n) => n.remove());
  const blocks = [];
  for (const el of doc.body.querySelectorAll(BLOCK_SEL)) {
    if (el.querySelector(BLOCK_SEL)) continue;
    sanitize(el);
    const text = el.textContent;
    if (!text.trim()) continue;
    blocks.push({
      tag: el.tagName === 'LI' ? 'p' : el.tagName.toLowerCase(),
      cls: el.className,
      html: el.innerHTML,
      text,
      page: state.page,
    });
    for (const m of el.querySelectorAll('.pagebreak')) {
      const n = /^\[(\d+)\]$/.exec(m.textContent);
      if (n) state.page = +n[1];
    }
  }
  return blocks;
}

export async function parseEpub(buffer) {
  const zip = await readZip(buffer);

  const container = await zip.text('META-INF/container.xml');
  const opfPath = container && byName(parseXml(container), 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('El archivo no es un EPUB válido');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parseXml(await zip.text(opfPath));

  const field = (name) => byName(opf, name)[0]?.textContent.trim() || '';
  const manifest = new Map(byName(opf, 'item').map((i) => [i.getAttribute('id'), {
    href: resolve(dir, i.getAttribute('href')),
    type: i.getAttribute('media-type') || '',
    props: i.getAttribute('properties') || '',
  }]));
  const spine = byName(opf, 'itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter(Boolean);

  // Títulos de capítulo desde el índice (NCX), si existe.
  const labels = new Map();
  const ncx = [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
  if (ncx) {
    const ncxDir = ncx.href.includes('/') ? ncx.href.slice(0, ncx.href.lastIndexOf('/') + 1) : '';
    const ncxText = await zip.text(ncx.href);
    for (const np of ncxText ? byName(parseXml(ncxText), 'navPoint') : []) {
      const label = byName(np, 'text')[0]?.textContent.trim();
      const src = byName(np, 'content')[0]?.getAttribute('src');
      if (label && src) labels.set(resolve(ncxDir, src), label);
    }
  }

  const state = { page: 0 };
  const chapters = [];
  for (const item of spine) {
    if (!/html/.test(item.type) || SKIP_FILE.test(item.href.split('/').pop())) continue;
    const xhtml = await zip.text(item.href);
    if (!xhtml) continue;
    const blocks = extractBlocks(xhtml, state);
    if (!blocks.length) continue;
    const heading = blocks.find((b) => /^h\d$/.test(b.tag));
    chapters.push({
      file: item.href.split('/').pop(),
      title: labels.get(item.href) || heading?.text || `Sección ${chapters.length + 1}`,
      blocks,
    });
  }
  if (!chapters.length) throw new Error('No se encontró texto en este EPUB');
  // La ficha del libro (derechos, versión) va al final para que se abra directo en el texto.
  const about = chapters.findIndex((c) => /^aboutbook/i.test(c.file));
  if (about >= 0 && about < chapters.length - 1) chapters.push(...chapters.splice(about, 1));

  let cover = null;
  const coverId = byName(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = manifest.get(coverId) || [...manifest.values()].find((i) => i.props.includes('cover-image'));
  if (coverItem) {
    const bytes = await zip.bytes(coverItem.href);
    if (bytes) cover = new Blob([bytes], { type: coverItem.type || 'image/jpeg' });
  }

  const title = field('title') || 'Sin título';
  return {
    meta: {
      // El identificador del EPUB no sirve: estos libros comparten el mismo UUID.
      id: slug(title),
      title,
      author: field('creator'),
      lang: field('language'),
      publisher: field('publisher'),
      rights: field('rights'),
    },
    cover,
    chapters,
  };
}
