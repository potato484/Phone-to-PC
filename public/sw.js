const CACHE_NAME = 'c2p-v75';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/tokens.css',
  '/style.css',
  '/app.js',
  '/lib/state.js',
  '/lib/term.js',
  '/lib/terminal-clear-policy.js',
  '/lib/terminal-input-policy.js',
  '/lib/terminal-replay-drop-policy.js',
  '/lib/control.js',
  '/lib/ui.js',
  '/lib/theme.js',
  '/lib/quality.js',
  '/lib/gesture-scroll-policy.js',
  '/lib/gestures.js',
  '/lib/files.js',
  '/lib/monitor.js',
  '/manifest.json',
  '/vendor/xterm.css',
  '/vendor/xterm.js',
  '/vendor/xterm-addon-fit.js',
  '/vendor/xterm-addon-attach.js',
  '/vendor/xterm-addon-webgl.js',
  '/vendor/marked.min.js',
  '/vendor/hljs/highlight.min.js',
  '/vendor/hljs/github.min.css',
  '/vendor/hljs/github-dark.min.css'
];

function shouldBypassRequest(url, request) {
  if (request.method !== 'GET') {
    return true;
  }
  if (url.origin !== self.location.origin) {
    return true;
  }
  if (url.pathname === '/sw.js' || url.pathname === '/reset-cache.html') {
    return true;
  }
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of APP_SHELL_ASSETS) {
        try {
          await cache.add(asset);
        } catch {
          // Keep service worker install resilient when optional assets are absent.
        }
      }
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((staleKey) => caches.delete(staleKey)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const payload = event && event.data;
  if (!payload || payload.type !== 'SKIP_WAITING') {
    return;
  }
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (shouldBypassRequest(requestUrl, event.request)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) {
        return cached;
      }

      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse && networkResponse.ok) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (error) {
        if (event.request.mode === 'navigate') {
          const fallback = await cache.match('/index.html');
          if (fallback) {
            return fallback;
          }
        }
        throw error;
      }
    })
  );
});
