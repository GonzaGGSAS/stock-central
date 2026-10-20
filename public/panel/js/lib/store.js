// Estado compartido mínimo: stores reactivos y recursos con caché (stale-while-revalidate).
import { useEffect, useReducer, useRef } from '../../vendor/htm-preact-3.1.1.js';

// ─── Store simple ────────────────────────────────────────────────────────────
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? next(state) : next;
      subs.forEach(fn => fn(state));
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function useStore(store, selector = (s) => s) {
  const [, force] = useReducer((x) => x + 1, 0);
  const sel = useRef(selector); sel.current = selector;
  const last = useRef(selector(store.get()));
  last.current = selector(store.get());
  useEffect(() => store.subscribe((s) => {
    const v = sel.current(s);
    if (v !== last.current) { last.current = v; force(); }
  }), [store]);
  return last.current;
}

// ─── Recursos ────────────────────────────────────────────────────────────────
// Cada recurso tiene una key (ej. "productos", "activity?category=sale").
// Si hay datos en caché se muestran al toque y se revalida en segundo plano.
const entries = new Map();

function entry(key) {
  let e = entries.get(key);
  if (!e) {
    e = { key, data: undefined, error: null, loading: false, stale: true, ts: 0, subs: new Set(), watchers: new Set(), fetcher: null, promise: null, timer: null, ctrl: null };
    entries.set(key, e);
  }
  return e;
}
function notify(e) { e.subs.forEach(fn => fn()); e.watchers.forEach(fn => fn()); }

export function loadResource(key, again = false) {
  const e = entry(key);
  if (!e.fetcher) return Promise.resolve();
  if (e.promise) { if (again) e.again = true; return e.promise; }
  e.loading = true;
  if (e.data === undefined) e.error = null; // reintento: se ve el skeleton en vez del error viejo
  e.ctrl = new AbortController();
  notify(e);
  e.promise = Promise.resolve()
    .then(() => e.fetcher(e.ctrl.signal))
    .then((d) => { e.data = d; e.error = null; e.ts = Date.now(); e.stale = false; },
      (err) => { if (err?.name !== 'AbortError') { e.error = err; e.stale = false; } })
    .finally(() => {
      e.loading = false; e.promise = null; e.ctrl = null; notify(e);
      if (e.again) { e.again = false; setTimeout(() => loadResource(key), 0); }
    });
  return e.promise;
}

/**
 * const r = useResource('overview', (signal) => api('/api/overview', { signal }))
 * r.data · r.error · r.loading (primera carga) · r.refreshing (revalidando) · r.reload() · r.mutate(fn)
 */
export function useResource(key, fetcher) {
  const [, force] = useReducer((x) => x + 1, 0);
  const e = key ? entry(key) : null;
  if (e) e.fetcher = fetcher;
  useEffect(() => {
    if (!e) return;
    e.subs.add(force);
    if (e.stale || e.data === undefined) loadResource(key);
    return () => { e.subs.delete(force); };
  }, [key]);
  if (!e) return { data: undefined, error: null, loading: false, refreshing: false, reload: () => {}, mutate: () => {} };
  return {
    data: e.data,
    error: e.error,
    loading: e.loading && e.data === undefined,
    refreshing: e.loading && e.data !== undefined,
    ts: e.ts,
    reload: () => loadResource(key),
    mutate: (fn) => mutateResource(key, fn),
  };
}

/** Lee un recurso ya cargado por otra vista, sin disparar fetch (para badges). */
export function useCached(key) {
  const [, force] = useReducer((x) => x + 1, 0);
  const e = entry(key);
  useEffect(() => { e.watchers.add(force); return () => { e.watchers.delete(force); }; }, [key]);
  return e.data;
}

export function mutateResource(key, fn) {
  const e = entries.get(key);
  if (!e) return;
  e.data = typeof fn === 'function' ? fn(e.data) : fn;
  notify(e);
}
export function peekResource(key) { return entries.get(key)?.data; }

/**
 * Marca como viejos los recursos cuyo key cumple `match` (string prefijo, RegExp o función)
 * y recarga —con debounce— solo los que están en pantalla.
 */
export function invalidate(match, { delay = 350 } = {}) {
  const test = typeof match === 'function' ? match
    : match instanceof RegExp ? (k) => match.test(k)
      : match === '*' ? () => true
        : (k) => k === match || k.startsWith(match + '?') || k.startsWith(match + ':');
  for (const [k, e] of entries) {
    if (!test(k)) continue;
    e.stale = true;
    if (e.subs.size) {
      clearTimeout(e.timer);
      e.timer = setTimeout(() => loadResource(k, true), delay);
    }
  }
}
