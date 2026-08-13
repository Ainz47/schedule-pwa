// App-shell cache so a reload survives no network. PouchDB already makes the
// *data* offline-capable (IndexedDB); this covers the other half - the HTML/
// JS/CSS files themselves, which would otherwise be fetched fresh from
// CouchDB on every navigation and fail outright with no network.
//
// Strategy is network-first with a cache fallback, not cache-first: this app
// has no build step or content hashing, so the only way a deploy's new files
// reach an already-installed device is by always preferring the network when
// it's reachable, and only falling back to the last-cached copy when it
// isn't. Bump CACHE_NAME on shell changes that must not mix old and new
// cached files together (rare - the network-first fetch handler already keeps
// the cache fresh on every online load).
const CACHE_NAME = 'schedule-shell-v2';

// Own scope only - this file is served at .../_design/app/sw.js, so its
// default registration scope is that same directory. Matches deploy.py's
// attachment names (src/ becomes "", vendor/ keeps its prefix).
// No "." / directory-index entry here: CouchDB attachments have no directory
// listing, unlike a normal static file server - only exact attachment names
// resolve.
const SHELL_FILES = [
  'index.html',
  'app.js',
  'actions.js',
  'bedtime.js',
  'block-edit.js',
  'campaign.js',
  'checks.js',
  'clock.js',
  'conflicts.js',
  'dates.js',
  'db.js',
  'ledger.js',
  'schedule.js',
  'streaks.js',
  'style.css',
  'manifest.json',
  'icon.svg',
  'template-edit.js',
  'todos.js',
  'ui/blocks.js',
  'ui/campaign.js',
  'ui/checks.js',
  'ui/coins.js',
  'ui/day.js',
  'ui/now.js',
  'ui/render.js',
  'ui/streaks.js',
  'ui/todos.js',
  'vendor/pouchdb.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only manage this app's own static files. CouchDB's data API
  // (_session, _local, _changes, _bulk_docs, replication, and every other
  // db under this origin) must reach the network untouched and uncached -
  // intercepting or caching those would corrupt sync, not speed it up.
  if (req.method !== 'GET' || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) {
    return;
  }

  event.respondWith(fetchThenCache(req));
});

// "Offline" for this app usually means the CouchDB host (a Tailscale machine)
// is powered off, not that the phone has no network at all. Its hostname
// still resolves and the phone still has connectivity, so a plain fetch()
// does not fail fast - it hangs on the TCP connect until the platform's own
// timeout, which can be tens of seconds. That reads as the app being stuck,
// not offline. Racing a short timeout against the fetch is what makes the
// cache fallback actually feel instant in that case.
const NETWORK_TIMEOUT_MS = 4000;

async function fetchThenCache(req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(req, { signal: controller.signal });
    const copy = res.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error('offline and not cached');
  } finally {
    clearTimeout(timer);
  }
}
