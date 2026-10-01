/**
 * Service worker di TODO UNIFI.
 *
 * Strategia: PRIMA LA RETE, la cache come riserva.
 * È la scelta giusta per un'app che continui a modificare: appena sei online
 * scarichi sempre l'ultima versione dei file, quindi un aggiornamento caricato
 * su GitHub si vede subito. La cache entra in gioco solo quando la rete manca,
 * e serve ad aprire l'app anche in aereo o in cantina.
 *
 * La strategia opposta (prima la cache) sarebbe piu veloce di qualche
 * millisecondo ma ti lascerebbe con la versione vecchia dopo ogni modifica:
 * il classico "ho aggiornato ma non cambia niente".
 */

const CACHE = 'todo-unifi-v3';

const FILE_BASE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './logo-unifi.png',
  './logo-unifi-blu.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Se un file non si scarica non blocchiamo l'installazione.
      .then((cache) => Promise.allSettled(FILE_BASE.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chiavi) => Promise.all(
        chiavi.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Tutto cio che non e nostro (SDK Firebase da gstatic, font di Google,
  // chiamate al database) passa dritto: non lo intercettiamo e non lo
  // mettiamo in cache, altrimenti rischieremmo di servire dati vecchi.
  if (url.origin !== self.location.origin) return;

  /*
   * cache: 'no-cache' obbliga il browser a ricontrollare il file col server
   * invece di riusare quello che ha gia in memoria. Serve perche GitHub Pages
   * dice ai browser "tieniti questo file per 10 minuti": senza questa riga,
   * dopo aver pubblicato una modifica si continuerebbe a vedere la versione
   * vecchia per un quarto d'ora buono, pur essendo online. Non scarica tutto
   * ogni volta: se il file non e cambiato il server risponde "uguale a prima"
   * e non ritrasmette niente.
   */
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((salvato) => {
          if (salvato) return salvato;
          // Navigazione senza rete e senza copia esatta: diamo la pagina.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
