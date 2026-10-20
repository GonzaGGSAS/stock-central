// Ruteo por hash: #/stock?f=sin&v=PRODUCTO|var_1
import { createStore, useStore } from './store.js';

export const VIEWS = ['inicio', 'stock', 'combos', 'actividad', 'ajustes'];

function parse() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const view = VIEWS.includes(path) ? path : 'inicio';
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { view, query };
}

export const route = createStore(parse());
window.addEventListener('hashchange', () => route.set(parse()));

export function href(view, query = {}) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
  return `#/${view}${q ? '?' + q : ''}`;
}

export function go(view, query = {}, { replace = false } = {}) {
  const h = href(view, query);
  if (replace) { history.replaceState(null, '', h); route.set(parse()); }
  else if (location.hash !== h) location.hash = h;
}

/** Cambia parámetros de la vista actual sin agregar entradas al historial (filtros, búsqueda). */
export function setQuery(patch, { push = false } = {}) {
  const cur = route.get();
  const next = { ...cur.query, ...patch };
  go(cur.view, next, { replace: !push });
}

export const useRoute = () => useStore(route);
