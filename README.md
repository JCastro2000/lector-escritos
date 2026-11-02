# Lector de Escritos

App web instalable (PWA) para leer libros EPUB: biblioteca, lectura sin conexión, buscador de citas,
destacados y ajustes de lectura. Todo se guarda en el dispositivo; no hay servidor.

## Probar en el computador

```bash
python -m http.server 8099 --directory "G:/Mi unidad/APP/lector"
```

Abrir http://localhost:8099 e importar los EPUB con el botón **Importar**.

## Instalar en el teléfono

- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** Compartir → *Añadir a pantalla de inicio*.

## Libros

Por defecto la app se publica **sin libros**: cada persona importa sus EPUB (descargados para uso
personal). El `.gitignore` bloquea `*.epub` y `library/books.json` para que no se publiquen por accidente.

### Ofrecer libros para descargar desde la app

Solo si cuentas con autorización para alojarlos (los textos en español de Elena G. de White tienen
derechos de autor):

1. Quita las dos líneas de `.gitignore`.
2. Ejecuta, con la carpeta donde tienes los EPUB:

   ```bash
   node tools/make-catalog.mjs "G:/Mi unidad/APP/EW"
   ```

   Esto copia los libros a `library/` y crea `library/books.json`. El título del catálogo es el
   nombre del archivo; para fijar la categoría de un libro añade `"category": "Vida cristiana"` en
   su entrada (la herramienta lo conserva al volver a ejecutarse).
3. Sube los cambios (`git add . && git commit && git push`). La app mostrará los libros como
   "Disponibles" (con nube) y los de cada teléfono con una marca verde cuando estén descargados.

Categorías: Historia de la redención, Vida cristiana, Testimonios y consejos, Salud, hogar y
educación, Devocionales y Otros libros (`js/catalog.js`).

## Al cambiar la app

Sube `VERSION` en `sw.js` para que los teléfonos descarguen la versión nueva.
