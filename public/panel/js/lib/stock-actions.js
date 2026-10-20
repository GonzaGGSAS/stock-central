// Ajustes de stock con actualización optimista, agrupado de clics y rollback si falla.
import { api } from './api.js';
import { createStore, mutateResource, peekResource, invalidate } from './store.js';
import { recomputeProducto } from './normalize.js';
import { toast } from '../ui/overlay.js';

export const PRODUCTOS_KEY = 'productos';
const enc = encodeURIComponent;

/** Estado por variante: { saving, error: {message, retry}, warn } */
export const rowState = createStore({});
const pending = new Map();  // vid → { pid, vid, delta, timer, label }: clics todavía sin mandar
const inflight = new Map(); // vid → cantidad de PUT en vuelo

const isLocked = (vid) => pending.has(vid) || (inflight.get(vid) || 0) > 0;
const lockIn = (vid) => inflight.set(vid, (inflight.get(vid) || 0) + 1);
function lockOut(vid) { const n = (inflight.get(vid) || 0) - 1; if (n > 0) inflight.set(vid, n); else inflight.delete(vid); }

function setRow(vid, patch) {
  rowState.set(s => {
    const n = { ...s };
    if (patch === null) delete n[vid]; else n[vid] = { ...(s[vid] || {}), ...patch };
    return n;
  });
}
export const clearRowError = (vid) => setRow(vid, { error: null });

function patchVar(pid, vid, fn) {
  mutateResource(PRODUCTOS_KEY, list => Array.isArray(list) ? list.map(p => p.id !== pid ? p
    : recomputeProducto({ ...p, variantes: p.variantes.map(v => v.id !== vid ? v : fn(v)) })) : list);
}
function findVar(pid, vid) {
  const list = peekResource(PRODUCTOS_KEY);
  return list?.find(p => p.id === pid)?.variantes.find(v => v.id === vid);
}
const withStock = (v, s) => { const stock = Math.max(0, Math.round(s)); return { ...v, stock, disponible: Math.max(0, stock - (v.reservado || 0)) }; };

/**
 * Después de recargar productos: mientras una variante tiene un guardado pendiente o en vuelo,
 * manda el valor local (optimista). Así una recarga en vivo no pisa ni duplica el cambio.
 */
export function applyOverlay(list) {
  if (!pending.size && !inflight.size) return list;
  const prev = peekResource(PRODUCTOS_KEY);
  if (!Array.isArray(prev)) return list;
  const prevVars = new Map();
  for (const p of prev) for (const v of p.variantes) prevVars.set(v.id, v);
  return list.map(p => {
    if (!p.variantes.some(v => isLocked(v.id))) return p;
    return recomputeProducto({ ...p, variantes: p.variantes.map(v => {
      if (!isLocked(v.id)) return v;
      const pv = prevVars.get(v.id);
      return pv ? withStock(v, pv.stock) : v;
    }) });
  });
}

function syncSummary(sync) {
  if (!sync) return { warn: null, text: '' };
  if (sync.ok === false && sync.error) return { warn: `No se pudo actualizar Tiendanube: ${sync.error}`, text: '' };
  // Tiendanube tardó: el server sigue sincronizando atrás y avisa por alertas si falla
  if (sync.pending) return { warn: null, text: ' · actualizando Tiendanube…' };
  const total = sync.total ?? 0;
  const errs = Array.isArray(sync.errors) ? sync.errors : [];
  if (errs.length) {
    return { warn: `Tiendanube no se actualizó en ${errs.length} de ${total}: ${errs[0]?.error || 'error'}${errs[0]?.label ? ` (${errs[0].label})` : ''}`, text: '' };
  }
  if (!total) return { warn: null, text: ' · sin productos de TN vinculados' };
  return { warn: null, text: ` · TN actualizado (${sync.updated ?? total}/${total})` };
}

function afterSave(pid, vid, r, label) {
  const { warn, text } = syncSummary(r?.sync);
  const unsent = pending.get(vid)?.delta || 0;
  if (r && r.stock != null && !inflight.has(vid)) patchVar(pid, vid, v => ({ ...withStock(v, Number(r.stock) + unsent), sync_error: warn || null }));
  else if (warn) patchVar(pid, vid, v => ({ ...v, sync_error: warn }));
  setRow(vid, { saving: isLocked(vid), error: null, warn });
  if (warn) toast(`${label}: stock ${r?.stock ?? ''} guardado. ${warn}`, { tone: 'warn', timeout: 9000 });
  else toast(`${label}: stock ${r?.stock ?? ''}${text}`);
  invalidate('overview'); invalidate('activity'); invalidate('log:' + pid);
}

/** +1 / −1: se muestra al instante y se manda junto si hacés varios clics seguidos. */
export function bumpStock(pid, vid, d, label) {
  const v = findVar(pid, vid);
  if (!v) return;
  const eff = Math.max(d, -v.stock);
  if (!eff) return;
  patchVar(pid, vid, x => withStock(x, x.stock + eff));
  const p = pending.get(vid) || { pid, vid, delta: 0, label };
  p.delta += eff;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(vid), 700);
  pending.set(vid, p);
  setRow(vid, { saving: true, error: null });
}

async function flush(vid) {
  const p = pending.get(vid);
  pending.delete(vid);
  if (!p || !p.delta) { setRow(vid, { saving: isLocked(vid) }); return; }
  lockIn(vid);
  try {
    const r = await api(`/api/productos/${enc(p.pid)}/variantes/${enc(vid)}/stock`, {
      method: 'PUT', body: { delta: p.delta, sync: true }, timeout: 90000,
    });
    lockOut(vid);
    afterSave(p.pid, vid, r, p.label);
  } catch (e) {
    lockOut(vid);
    patchVar(p.pid, vid, v => withStock(v, v.stock - p.delta));
    const delta = p.delta;
    setRow(vid, {
      saving: isLocked(vid),
      error: { message: `No se guardó el ${delta > 0 ? '+' : '−'}${Math.abs(delta)}: ${e.message}`, retry: () => { clearRowError(vid); bumpStock(p.pid, vid, delta, p.label); } },
    });
  }
}

/** Fijar valor exacto o sumar/restar con motivo (sin agrupar). */
export async function saveStock(pid, vid, { absolute, delta, reason }, label) {
  const v = findVar(pid, vid);
  // Si había clics sin mandar, los descartamos: este valor manda.
  const p = pending.get(vid);
  if (p) { clearTimeout(p.timer); pending.delete(vid); }
  const prev = v ? v.stock - (p?.delta || 0) : null;
  const target = absolute != null ? Number(absolute) : (prev ?? 0) + Number(delta || 0);
  if (v) patchVar(pid, vid, x => withStock(x, target));
  setRow(vid, { saving: true, error: null });
  const body = absolute != null ? { absolute: Number(absolute), sync: true } : { delta: Number(delta), sync: true };
  if (reason) body.reason = reason;
  lockIn(vid);
  try {
    const r = await api(`/api/productos/${enc(pid)}/variantes/${enc(vid)}/stock`, { method: 'PUT', body, timeout: 90000 });
    lockOut(vid);
    afterSave(pid, vid, r, label);
    return r;
  } catch (e) {
    lockOut(vid);
    if (prev != null) patchVar(pid, vid, x => withStock(x, prev));
    setRow(vid, { saving: isLocked(vid), error: { message: `No se guardó el stock: ${e.message}`, retry: () => { clearRowError(vid); saveStock(pid, vid, { absolute, delta, reason }, label).catch(() => {}); } } });
    throw e;
  }
}

// ─── Otras acciones de productos ─────────────────────────────────────────────
function refreshStock(pid) {
  invalidate(PRODUCTOS_KEY, { delay: 0 }); invalidate('overview');
  if (pid) invalidate('log:' + pid);
}

export async function linkTn(pid, vid, link) {
  await api(`/api/productos/${enc(pid)}/variantes/${enc(vid)}/links`, { method: 'POST', body: link });
  mutateResource(PRODUCTOS_KEY, list => list?.map(p => p.id !== pid ? p : {
    ...p, variantes: p.variantes.map(v => v.id !== vid ? v : { ...v, links: [...v.links, { ...link, tn_stock: null }] }),
  }));
  refreshStock(pid);
}

export async function unlinkTn(pid, vid, variantId) {
  await api(`/api/productos/${enc(pid)}/variantes/${enc(vid)}/links/${enc(variantId)}`, { method: 'DELETE' });
  mutateResource(PRODUCTOS_KEY, list => list?.map(p => p.id !== pid ? p : {
    ...p, variantes: p.variantes.map(v => v.id !== vid ? v : { ...v, links: v.links.filter(l => String(l.variant_id) !== String(variantId)) }),
  }));
  refreshStock(pid);
}

export async function deleteVariante(pid, vid) {
  await api(`/api/productos/${enc(pid)}/variantes/${enc(vid)}`, { method: 'DELETE' });
  mutateResource(PRODUCTOS_KEY, list => list?.map(p => p.id !== pid ? p : recomputeProducto({ ...p, variantes: p.variantes.filter(v => v.id !== vid) })));
  refreshStock(pid);
}

export async function deleteProducto(pid) {
  await api(`/api/productos/${enc(pid)}`, { method: 'DELETE' });
  mutateResource(PRODUCTOS_KEY, list => list?.filter(p => p.id !== pid));
  refreshStock();
}

export async function addVariante(pid, label, stock) {
  const r = await api(`/api/productos/${enc(pid)}/variantes`, { method: 'POST', body: { label, stock: Number(stock) || 0 } });
  refreshStock(pid);
  return r;
}

export async function importVariantesTn(pid) {
  const r = await api(`/api/productos/${enc(pid)}/sync-variantes`, { method: 'POST', timeout: 90000 });
  refreshStock(pid);
  return r;
}

export async function importProducto(body) {
  const r = await api('/api/productos/import', { method: 'POST', body, timeout: 90000 });
  refreshStock(r?.id);
  return r;
}

export async function createProducto(id, nombre) {
  const r = await api('/api/productos', { method: 'POST', body: { id, nombre } });
  refreshStock();
  return r;
}
