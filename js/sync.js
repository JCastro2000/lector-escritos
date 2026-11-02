// Cuenta y sincronización con Firebase (opcional). Sin cuenta, la app funciona igual y todo queda en el dispositivo.
//
// Se sincronizan: destacados, favoritos y posición de lectura. Los datos locales siguen siendo la
// referencia (la app funciona sin internet); aquí solo se suben los cambios pendientes y se
// aplican los que llegan de otros dispositivos. En cada elemento gana el cambio más reciente.
//
// Estructura en Firestore (solo accesible por su dueño, ver firestore.rules):
//   users/{uid}/highlights/{id}      un destacado (con `updated`, `deleted` y `st` = hora del servidor)
//   users/{uid}/positions/{libro}    { c, b, t }  capítulo, párrafo y fecha de la última lectura
//   users/{uid}/meta/favorites       { items: { libro: { on, t } } }
import * as db from './db.js';
import * as favorites from './favorites.js';
import { firebaseConfig } from './firebase-config.js';
import { confirmAction } from './ui.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const ACCOUNT_KEY = 'lector.account'; // { uid, email } mientras hay sesión
const UID_KEY = 'lector.syncUid'; // cuenta a la que pertenecen los datos de este dispositivo
const PULL_KEY = 'lector.lastPull.'; // + uid: hora del servidor del último destacado recibido

// phase: off | idle | syncing | offline | error
export const state = { phase: 'off', last: 0, error: '' };
const setState = (patch) => {
  Object.assign(state, patch);
  db.notify('sync');
};

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch { /* sin almacenamiento */ }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch { /* sin almacenamiento */ }
  },
};

export function account() {
  try {
    return JSON.parse(store.get(ACCOUNT_KEY));
  } catch {
    return null;
  }
}

// ---------- SDK de Firebase (se descarga solo si hay cuenta o se intenta iniciar sesión) ----------
let loading;
function load() {
  loading ??= (async () => {
    const [app, auth, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const application = app.initializeApp(firebaseConfig);
    return { auth, fs, a: auth.getAuth(application), db: fs.getFirestore(application) };
  })().catch((e) => {
    loading = null; // se reintenta la próxima vez (por ejemplo, al volver la conexión)
    throw e;
  });
  return loading;
}

const MESSAGES = {
  'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar.',
  'auth/cancelled-popup-request': 'Ya hay una ventana de Google abierta.',
  'auth/popup-blocked': 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo otra vez.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a intentar.',
  'auth/user-disabled': 'Esta cuenta está desactivada.',
  'auth/network-request-failed': 'No hay conexión a internet.',
  'auth/operation-not-allowed': 'El acceso con Google no está activado en Firebase.',
  'auth/configuration-not-found': 'Falta activar Authentication en Firebase.',
  'auth/unauthorized-domain': 'Esta dirección no está autorizada en Firebase (Authentication → Configuración → Dominios autorizados).',
  'permission-denied': 'Tu correo aún no está autorizado. Pídele a quien administra la app que lo agregue.',
  unavailable: 'No se pudo conectar con la nube.',
};

export function friendlyError(e) {
  if (!navigator.onLine) return 'No hay conexión a internet.';
  return MESSAGES[e?.code] ?? MESSAGES[e?.code?.replace('firestore/', '')] ?? (e?.message ? `Error: ${e.message}` : 'Ocurrió un error inesperado.');
}

// ---------- Sesión ----------
let listening = false;
async function ensureListener() {
  const sdk = await load();
  if (listening) return sdk;
  listening = true;
  sdk.auth.onAuthStateChanged(sdk.a, (user) => (user ? attach(user) : detach(true)));
  return sdk;
}

export async function start() {
  if (!account()) return;
  setState({ phase: navigator.onLine ? 'syncing' : 'offline' });
  try {
    await ensureListener();
  } catch {
    setState({ phase: 'offline' });
  }
}

// Descarga el SDK por adelantado: la ventana de Google tiene que abrirse al instante al tocar el botón.
export const preload = () => ensureListener().catch(() => {});

export async function signInWithGoogle() {
  const { auth, a } = await ensureListener();
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await auth.signInWithPopup(a, provider);
}

export async function signOut() {
  await syncNow(); // sube lo pendiente antes de salir
  const { auth, a } = await load();
  await auth.signOut(a);
}

// ---------- Conexión con la nube ----------
let uid = null;
let unsubs = [];
let remotePositions = new Map();

async function attach(user) {
  detach(false);
  const previous = store.get(UID_KEY);
  if (previous && previous !== user.uid) {
    const ok = await confirmAction(
      'Cambiar de cuenta',
      `Este dispositivo tenía las citas de otra cuenta. Se reemplazarán por las de ${user.email}. Las de la otra cuenta siguen guardadas en la nube.`,
      'Cambiar',
    );
    if (!ok) {
      const { auth, a } = await load();
      await auth.signOut(a);
      return;
    }
    await db.wipeUserData();
    favorites.wipe();
    store.remove(PULL_KEY + previous);
  }
  store.set(UID_KEY, user.uid);
  store.set(ACCOUNT_KEY, JSON.stringify({ uid: user.uid, email: user.email }));
  uid = user.uid;
  setState({ phase: 'syncing', error: '' });
  await joinIfOpen(user);
  await subscribe();
  schedule(0);
}

// Alta automática: la primera vez que alguien entra con Google se agrega su correo a "allowed".
// Las reglas solo lo permiten mientras config/acceso tenga abierto = "si"; el administrador lo
// cambia a "no" en Firebase para cerrar las altas nuevas sin afectar a quienes ya están.
async function joinIfOpen(user) {
  if (!user.email) return;
  try {
    const { fs, db: cloud } = await load();
    const ref = fs.doc(cloud, 'allowed', user.email);
    if ((await fs.getDoc(ref)).exists()) return;
    await fs.setDoc(ref, { activo: 'si', fecha: fs.serverTimestamp() });
  } catch {
    // Altas cerradas o sin conexión: si no está autorizado, la sincronización lo avisará.
  }
}

function detach(signedOut) {
  unsubs.forEach((u) => u());
  unsubs = [];
  remotePositions = new Map();
  uid = null;
  if (signedOut) {
    store.remove(ACCOUNT_KEY);
    setState({ phase: 'off', error: '' });
  }
}

const onError = (e) => setState({ phase: 'error', error: friendlyError(e) });

async function subscribe() {
  const { fs, db: cloud } = await load();
  const user = uid;
  const since = fs.Timestamp.fromMillis(+store.get(PULL_KEY + user) || 0);

  unsubs.push(fs.onSnapshot(
    fs.query(fs.collection(cloud, 'users', user, 'highlights'), fs.where('st', '>', since)),
    async (snap) => {
      let newest = 0;
      const incoming = [];
      for (const change of snap.docChanges()) {
        if (change.type === 'removed' || change.doc.metadata.hasPendingWrites) continue;
        const { st, ...data } = change.doc.data();
        if (st) newest = Math.max(newest, st.toMillis());
        incoming.push(data);
      }
      await db.applyRemoteHighlights(incoming);
      if (newest) store.set(PULL_KEY + user, String(Math.max(newest, +store.get(PULL_KEY + user) || 0)));
      setState({ phase: 'idle', last: Date.now(), error: '' });
    },
    onError,
  ));

  unsubs.push(fs.onSnapshot(fs.collection(cloud, 'users', user, 'positions'), async (snap) => {
    remotePositions = new Map(snap.docs.map((d) => [d.id, d.data()]));
    await applyPositions();
  }, onError));

  unsubs.push(fs.onSnapshot(fs.doc(cloud, 'users', user, 'meta', 'favorites'), (snap) => {
    favorites.applyRemote(snap.data()?.items ?? {});
  }, onError));
}

// La posición de la nube se aplica si es más reciente que la local (y cuando se descarga un libro que faltaba).
async function applyPositions() {
  let changed = false;
  for (const book of await db.listBooks()) {
    const r = remotePositions.get(book.id);
    if (r && r.t > (book.lastRead ?? 0)) {
      await db.updateBook(book.id, { pos: { c: r.c, b: r.b }, lastRead: r.t, posSynced: r.t }, { silent: true });
      changed = true;
    }
  }
  if (changed) db.notify('books', { remote: true });
}

async function pushPending() {
  const { fs, db: cloud } = await load();
  const user = uid;

  const pending = (await db.rawHighlights()).filter((h) => db.stamp(h) > (h.syncedAt ?? 0));
  for (let i = 0; i < pending.length; i += 400) {
    const chunk = pending.slice(i, i + 400);
    const batch = fs.writeBatch(cloud);
    for (const h of chunk) {
      const { syncedAt, ...data } = h;
      batch.set(fs.doc(cloud, 'users', user, 'highlights', h.id), { ...data, updated: db.stamp(h), deleted: !!h.deleted, st: fs.serverTimestamp() });
    }
    await batch.commit();
    await db.markHighlightsSynced(chunk.map((h) => ({ id: h.id, updated: db.stamp(h) })));
  }

  const favs = favorites.dirty();
  if (Object.keys(favs).length) {
    const items = Object.fromEntries(Object.entries(favs).map(([id, v]) => [id, { on: v.on, t: v.t }]));
    await fs.setDoc(fs.doc(cloud, 'users', user, 'meta', 'favorites'), { items }, { merge: true });
    favorites.markSynced(favs);
  }

  for (const book of await db.listBooks()) {
    if (book.pos && book.lastRead > (book.posSynced ?? 0)) {
      await fs.setDoc(fs.doc(cloud, 'users', user, 'positions', book.id), { c: book.pos.c, b: book.pos.b, t: book.lastRead });
      await db.updateBook(book.id, { posSynced: book.lastRead }, { silent: true });
    }
  }
}

// ---------- Cuándo sincronizar ----------
let timer;
let running = false;
let again = false;

export function schedule(ms = 3000) {
  if (!uid) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export async function syncNow() {
  if (!uid) return;
  clearTimeout(timer);
  if (!navigator.onLine) return setState({ phase: 'offline' });
  if (running) {
    again = true;
    return;
  }
  running = true;
  setState({ phase: 'syncing', error: '' });
  try {
    await Promise.race([pushPending(), new Promise((_, reject) => setTimeout(reject, 30000, new Error('La sincronización tardó demasiado.')))]);
    setState({ phase: 'idle', last: Date.now(), error: '' });
  } catch (e) {
    setState({ phase: 'error', error: friendlyError(e) });
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(1000);
    }
  }
}

db.events.addEventListener('highlights', (e) => !e.detail.remote && schedule());
db.events.addEventListener('favorites', (e) => !e.detail.remote && schedule());
db.events.addEventListener('books', (e) => {
  if (e.detail.remote) return;
  schedule(15000); // la posición de lectura cambia seguido; se agrupa
  if (uid) applyPositions(); // por si se acaba de descargar un libro con posición guardada en la nube
});
addEventListener('online', () => {
  if (account() && !uid) start();
  syncNow();
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && syncNow());
