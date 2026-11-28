// PP QUEST Web — Smart Stale-While-Revalidate Image & Static Asset Cache Service Worker
const IMG_CACHE = 'pp-quest-img-swr-v1';

const CACHEABLE_IMAGE_HOSTS = [
  'mzstatic.com',
  'play-lh.googleusercontent.com',
  'lh3.googleusercontent.com',
  'googleusercontent.com',
  'encrypted-tbn0.gstatic.com',
  '.r2.dev',
  'i.ibb.co',
  'imgur.com',
  'postimg.cc',
  'cloudinary.com',
  'upload.wikimedia.org',
  'ui-avatars.com'
];

const NEVER_CACHE_HOSTS = [
  'ppmod-api.tredarskvt.workers.dev',
  'pp-mod-auto-quest.onrender.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'api.telegram.org'
];

function isCacheableImage(urlObj, req) {
  const href = urlObj.href.toLowerCase();
  for (let i = 0; i < NEVER_CACHE_HOSTS.length; i++) {
    if (href.includes(NEVER_CACHE_HOSTS[i])) return false;
  }
  if (req.destination === 'image') return true;
  const host = urlObj.hostname.toLowerCase();
  for (let i = 0; i < CACHEABLE_IMAGE_HOSTS.length; i++) {
    if (host.includes(CACHEABLE_IMAGE_HOSTS[i])) return true;
  }
  const p = urlObj.pathname.toLowerCase();
  return (
    p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.jpeg') ||
    p.endsWith('.webp') || p.endsWith('.gif') || p.endsWith('.svg') || p.endsWith('.ico')
  );
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(IMG_CACHE).then((cache) =>
      cache.addAll(['pp_quest_logo.png', 'PPCOIN.png', 'brand_logo.png', 'fb.png', 'hd.png']).catch(() => {})
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== IMG_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let urlObj;
  try {
    urlObj = new URL(req.url);
  } catch (e) {
    return;
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return;
  if (!isCacheableImage(urlObj, req)) return;

  // Stale-While-Revalidate: serve cached image in <2ms, refresh quietly in background so updates appear automatically!
  event.respondWith(
    caches.open(IMG_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const netPromise = fetch(req).then((netResp) => {
        if (netResp && (netResp.ok || netResp.type === 'opaque')) {
          cache.put(req, netResp.clone()).catch(() => {});
        }
        return netResp;
      }).catch(() => cached);

      if (cached) {
        event.waitUntil(netPromise);
        return cached;
      }
      return netPromise;
    })
  );
});
