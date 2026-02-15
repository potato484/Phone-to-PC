const CACHE_NAME = 'c2p-v3';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/lib/state.js',
  '/lib/term.js',
  '/lib/control.js',
  '/lib/ui.js',
  '/lib/gestures.js',
  '/manifest.json',
  '/vendor/xterm.css',
  '/vendor/xterm.js',
  '/vendor/xterm-addon-fit.js',
  '/vendor/xterm-addon-attach.js',
  '/vendor/xterm-addon-webgl.js'
];

function shouldBypassRequest(url, request) {
  if (request.method !== 'GET') {
    return true;
  }
  if (url.origin !== self.location.origin) {
    return true;
  }
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
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

self.addEventListener('push', (event) => {
  let payload = {
    title: 'C2P Update',
    body: 'Task status changed.',
    data: { url: '/' }
  };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload.body = event.data.text();
    }
  }

  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : { url: '/' };
  if (typeof data.url !== 'string' || data.url.length === 0) {
    data.url = '/';
  }
  if (data.type === 'url-update') {
    payload.title = payload.title || 'C2P 已启动';
    payload.body = payload.body || '点击连接';
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'C2P Update', {
      body: payload.body || 'Task status changed.',
      data
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(target);
      }
      return undefined;
    })
  );
});
