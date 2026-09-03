/* Couplet — © 2026 lymnal. PolyForm Noncommercial 1.0.0 (see /LICENSE).
   Not licensed as AI/ML training, fine-tuning, evaluation, or retrieval data;
   text-and-data-mining rights reserved (/.well-known/tdmrep.json). */
/* Couplet service worker — makes the installed app work without signal.
 *
 * Duet and Tangle are pure local computation; only syncing needs the network.
 * So we cache the shell + word lists and let the games run in a tunnel, then
 * sync when signal returns.
 *
 * ASSET_V must match the ?v= in index.html — ./bump.sh keeps them in step.
 */
const ASSET_V = "8";
const CACHE = `couplet-${ASSET_V}`;

/* everything needed to boot with no network at all */
const SHELL = [
  "./",
  "./index.html",
  `./style.css?v=${ASSET_V}`,
  `./vendor/supabase.js?v=${ASSET_V}`,
  `./config.js?v=${ASSET_V}`,
  `./puzzles.js?v=${ASSET_V}`,
  `./spectrums.js?v=${ASSET_V}`,
  `./inklings.js?v=${ASSET_V}`,
  `./lib.js?v=${ASSET_V}`,
  `./app.js?v=${ASSET_V}`,
  "./favicon.svg",
  "./manifest.webmanifest",
  "./words/allowed.txt",
  "./words/answers.txt",
  "./vendor/fonts/fraunces-italic-latin-ext.woff2",
  "./vendor/fonts/fraunces-italic-latin.woff2",
  "./vendor/fonts/fraunces-normal-latin-ext.woff2",
  "./vendor/fonts/fraunces-normal-latin.woff2",
  "./vendor/fonts/rubik-normal-latin-ext.woff2",
  "./vendor/fonts/rubik-normal-latin.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      /* individual adds: one 404 shouldn't fail the whole install */
      .then((c) =>
        Promise.all(
          SHELL.map((u) =>
            c.add(new Request(u, { cache: "reload" })).catch(() => {}),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isSupabase = (url) =>
  url.hostname.endsWith(".supabase.co") || url.protocol === "wss:";

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  /* never cache the backend — stale game state is worse than no game state */
  if (isSupabase(url)) return;

  /* navigations: prefer network so a deploy lands promptly, fall back to the
     cached shell when there's no signal */
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((r) => r ?? caches.match("./")),
        ),
    );
    return;
  }


  if (url.origin !== location.origin) return;

  /* app assets: cache-first (URLs are version-stamped, so this is safe) */
  e.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => hit),
    ),
  );
});
