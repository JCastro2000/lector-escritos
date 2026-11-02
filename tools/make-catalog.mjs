// Prepara los libros que se publicarán junto a la app.
//
//   node tools/make-catalog.mjs <carpeta con los .epub>
//
// Copia cada EPUB a library/ con un nombre limpio y genera library/books.json,
// que la app lee para ofrecer los libros como "Disponibles para descargar".
// Si ya existe un books.json, conserva la "category" que hayas escrito a mano.
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('Uso: node tools/make-catalog.mjs <carpeta con los .epub>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'library');
const jsonPath = join(outDir, 'books.json');

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
  const category = categoryByTitle.get(slug(title));
  if (category) entry.category = category;
  catalog.push(entry);
}

await writeFile(jsonPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`${catalog.length} libros en library/books.json`);
catalog.forEach((b) => console.log(` - ${b.title} (${(b.size / 1048576).toFixed(2)} MB)`));
