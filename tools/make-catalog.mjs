// Prepara los libros que se publicarán junto a la app.
//
//   node tools/make-catalog.mjs <carpeta con los .epub>
//
// Copia cada EPUB a library/ con un nombre limpio y genera library/books.json,
// que la app lee para ofrecer los libros como "Disponibles para descargar".
// Si ya existe un books.json, conserva la "category" que hayas escrito a mano.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { readZip } from '../js/zip.js';

const source = process.argv[2];
if (!source) {
  console.error('Uso: node tools/make-catalog.mjs <carpeta con los .epub>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'library');
const jsonPath = join(outDir, 'books.json');

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

// Extrae la portada del EPUB a library/covers/ y devuelve su ruta relativa (o null si no tiene).
async function extractCover(epubPath, name) {
  const raw = await readFile(epubPath);
  const zip = readZip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const opfPath = /full-path="([^"]+)"/.exec(await zip.text('META-INF/container.xml'))?.[1];
  if (!opfPath) return null;
  const opf = await zip.text(opfPath);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const metaCover = [...opf.matchAll(/<meta\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, 'name') === 'cover');
  const coverId = metaCover && attr(metaCover, 'content');
  const item = [...opf.matchAll(/<item\b[^>]*>/g)].map((m) => m[0])
    .find((t) => (coverId ? attr(t, 'id') === coverId : /properties="[^"]*cover-image/.test(t)));
  const href = item && attr(item, 'href');
  if (!href) return null;
  const bytes = await zip.bytes(decodeURIComponent(new URL(href, 'http://x/' + dir).pathname.slice(1)));
  if (!bytes) return null;
  const rel = `covers/${name}${extname(href).toLowerCase() || '.jpg'}`;
  await mkdir(join(outDir, 'covers'), { recursive: true });
  await writeFile(join(outDir, rel), bytes);
  return rel;
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let previous = [];
try {
  previous = JSON.parse(await readFile(jsonPath, 'utf8'));
} catch { /* primera vez */ }
const categoryByTitle = new Map(previous.filter((b) => b.category).map((b) => [slug(b.title), b.category]));

await mkdir(outDir, { recursive: true });
const files = (await readdir(source)).filter((f) => extname(f).toLowerCase() === '.epub').sort((a, b) => a.localeCompare(b, 'es'));

const catalog = [];
for (const name of files) {
  const title = basename(name, extname(name)).trim();
  const file = `${slug(title)}.epub`;
  await copyFile(join(source, name), join(outDir, file));
  const entry = { title, file, size: (await stat(join(outDir, file))).size };
  const cover = await extractCover(join(outDir, file), slug(title));
  if (cover) entry.cover = cover;
  const category = categoryByTitle.get(slug(title));
  if (category) entry.category = category;
  catalog.push(entry);
}

// Miniaturas de las portadas (la biblioteca las usa en lugar de la imagen completa). Solo en Windows.
if (process.platform === 'win32') {
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'make-thumbs.ps1'), join(outDir, 'covers'), join(outDir, 'thumbs')], { encoding: 'utf8' });
  if (run.status !== 0) console.warn('No se pudieron generar las miniaturas:', run.stderr || run.stdout);
} else {
  console.warn('Miniaturas omitidas (requiere Windows); la app usará la portada completa.');
}
for (const entry of catalog) {
  if (entry.cover && existsSync(join(outDir, 'thumbs', `${basename(entry.cover, extname(entry.cover))}.jpg`))) {
    entry.thumb = `thumbs/${basename(entry.cover, extname(entry.cover))}.jpg`;
  }
}

await writeFile(jsonPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`${catalog.length} libros en library/books.json`);
catalog.forEach((b) => console.log(` - ${b.title} (${(b.size / 1048576).toFixed(2)} MB)`));
