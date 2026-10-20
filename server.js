/**
 * STOCK CENTRAL v2 + Reservas - Backend para Tiendanube
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fs = require('fs');
const crypto = require('crypto');

const path = require('path');

// DB_PATH y TN_API_BASE se pueden cambiar por env (los tests usan una DB temporal y un TN falso)
const DB_PATH = process.env.DB_PATH || './data/db.json';
const TN_API_BASE = (process.env.TN_API_BASE || 'https://api.tiendanube.com/2025-03').replace(/\/$/, '');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Escritura atómica: si el proceso muere a mitad de un write, db.json no queda truncado
class AtomicFileSync extends FileSync {
  write(data) {
    const tmp = `${this.source}.tmp`;
    fs.writeFileSync(tmp, this.serialize(data));
    fs.renameSync(tmp, this.source);
  }
}
const adapter = new AtomicFileSync(DB_PATH);
const db = low(adapter);

db.defaults({
  config: { access_token: '', store_id: '', webhook_registered: false },
  productos: [],
  reservations: [], // { id, sessionId, productoId, varianteId, qty, expiresAt }
  matchs: [],       // { id, nombre, producto1: {tn_product_id, nombre}, producto2: {tn_product_id, nombre} }
  alerts: [],       // errores para mostrar en el panel (ver addAlert)
  order_items: {},  // idempotencia de órdenes: "order|producto|variante|tn_variant" → { state: sold|returned, qty }
  meta: {}          // marcas de tiempo: último webhook, última reconciliación, piso de la revisión de órdenes
}).write();

const app = express();
app.use(cors());
// rawBody se guarda para poder verificar la firma HMAC de los webhooks
app.use(bodyParser.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
// Panel web (public/panel) servido en la raíz
app.use(express.static(path.join(__dirname, 'public', 'panel')));

// Auth opcional del panel: si ADMIN_TOKEN está configurado, /api/* pide
// "Authorization: Bearer <token>" (o ?token= para el SSE). El storefront
// (reservas) y /api/health siguen siendo públicos.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
app.use((req, res, next) => {
  // Express rutea sin distinguir mayúsculas: comparar en minúsculas
  const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  if (!ADMIN_TOKEN || !(p === '/api' || p.startsWith('/api/')) || req.method === 'OPTIONS') return next();
  if (p === '/api/health') return next();
  if (p === '/api/reserve' && req.method === 'POST') return next();
  if (p.startsWith('/api/reserve/') && req.method === 'DELETE') return next();
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.token || '');
  if (token && safeEqual(token, ADMIN_TOKEN)) return next();
  res.status(401).json({ error: 'No autorizado', code: 'unauthorized' });
});
const PORT = process.env.PORT || 3001;
const RESERVATION_MS = 30 * 60 * 1000; // 30 minutos

// ─── Helper: API Tiendanube ──────────────────────────────────────────────────
// Rate limit de TN: leaky bucket de 40 requests que se vacía a 2 por segundo.
// Todas las llamadas pasan por este bucket (capacidad 30, margen de seguridad) y
// los 429 se reintentan con backoff, así las cascadas de syncs no revientan.
const TN_THROTTLE = process.env.TN_THROTTLE !== 'off';
const tnBucket = { tokens: 30, capacity: 30, perSec: 2, last: Date.now() };
async function tnTakeToken() {
  if (!TN_THROTTLE) return;
  for (;;) {
    const now = Date.now();
    tnBucket.tokens = Math.min(tnBucket.capacity, tnBucket.tokens + ((now - tnBucket.last) / 1000) * tnBucket.perSec);
    tnBucket.last = now;
    if (tnBucket.tokens >= 1) { tnBucket.tokens -= 1; return; }
    await sleep(Math.ceil(((1 - tnBucket.tokens) / tnBucket.perSec) * 1000));
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tnRequest(method, path, body = null) {
  const { access_token, store_id } = db.get('config').value();
  if (!access_token || !store_id) throw new Error('No configurado');
  const fetch = (await import('node-fetch')).default;
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    await tnTakeToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(`${TN_API_BASE}/${store_id}${path}`, {
        method,
        headers: { 'Authentication': `bearer ${access_token}`, 'Content-Type': 'application/json', 'User-Agent': 'StockCentral (soporte@minch.com.ar)' },
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(e.name === 'AbortError' ? 'Tiendanube no respondió (timeout)' : `No se pudo conectar con Tiendanube: ${e.message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { description: text.slice(0, 200) }; }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      // x-rate-limit-reset viene en ms hasta que el bucket se vacía
      const reset = toNum(res.headers.get('x-rate-limit-reset'));
      const wait = Math.min(10000, Math.max(reset, 1000 * 2 ** attempt));
      tnBucket.tokens = 0;
      console.warn(`[TN] 429 en ${method} ${path} — reintento ${attempt + 1} en ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const err = new Error(data.description || data.message || `API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

// ─── Helper: forzar número (corrige stocks guardados como string) ───────────
// Bug histórico: si variante.stock quedó como string, "4" + 1 = "41" (concat)
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ════════════════════════════════════════════════════════════════════════════
// Eventos en vivo (SSE) — el panel se actualiza solo, sin refrescar
// ════════════════════════════════════════════════════════════════════════════
const sseClients = new Set();
const pendingTopics = new Map();
let emitTimer = null;
function emitChange(topic, data = {}) {
  pendingTopics.set(topic + JSON.stringify(data), { topic, ...data });
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    const items = [...pendingTopics.values()];
    pendingTopics.clear();
    for (const item of items) {
      const payload = `event: change\ndata: ${JSON.stringify(item)}\n\n`;
      for (const c of sseClients) { try { c.write(payload); } catch (_) { /* cliente caído */ } }
    }
  }, 250);
}

// ════════════════════════════════════════════════════════════════════════════
// Alertas — los errores que el dueño tiene que ver en el panel
// ════════════════════════════════════════════════════════════════════════════
const ALERTS_MAX = 300;
function addAlert({ key, type, severity = 'warning', title, detail = '', reopen = false, once = false, ...rest }) {
  const now = new Date().toISOString();
  const list = db.get('alerts').value();
  const existing = key ? list.find(a => a.key === key) : null;
  if (existing && once) return existing; // mismo evento (misma orden): no se cuenta dos veces
  if (existing) {
    existing.count = (existing.count || 1) + (reopen || !existing.dismissed ? 1 : 0);
    existing.detail = detail || existing.detail;
    existing.title = title || existing.title;
    if (reopen) { existing.ts = now; existing.dismissed = false; existing.resolved = false; }
    db.write();
    emitChange('alerts');
    return existing;
  }
  const alert = {
    id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    key: key || null, ts: now, type, severity, title, detail, count: 1, dismissed: false, ...rest
  };
  list.unshift(alert);
  if (list.length > ALERTS_MAX) {
    // primero se van las descartadas más viejas
    for (let i = list.length - 1; i >= 0 && list.length > ALERTS_MAX; i--) if (list[i].dismissed) list.splice(i, 1);
    if (list.length > ALERTS_MAX) list.length = ALERTS_MAX;
  }
  db.write();
  emitChange('alerts');
  console.warn(`[ALERTA] ${type}: ${title}${detail ? ' — ' + detail : ''}`);
  return alert;
}
// Marca como resueltas las alertas abiertas con esa key (ej: el sync volvió a funcionar)
function resolveAlert(key) {
  const a = db.get('alerts').value().find(x => x.key === key && !x.dismissed);
  if (!a) return;
  a.dismissed = true; a.resolved = true; a.resolved_at = new Date().toISOString();
  db.write();
  emitChange('alerts');
}

function setMeta(k, v) { db.set(`meta.${k}`, v).write(); }

// ════════════════════════════════════════════════════════════════════════════
// Búsquedas y log
// ════════════════════════════════════════════════════════════════════════════
const LOG_MAX = 400; // movimientos guardados por variante (la idempotencia vive en order_items)

function getVariantRef(productoId, varianteId) {
  return db.get('productos').find({ id: productoId }).get('variantes').find({ id: varianteId });
}

// Variante interna de SC que tiene vinculada esta variante de TN (link directo)
function findInternalByTnVariant(tn_variant_id) {
  const id = String(tn_variant_id);
  for (const p of db.get('productos').value()) {
    for (const v of p.variantes || []) {
      const link = (v.links || []).find(l => String(l.variant_id) === id);
      if (link) return { productoId: p.id, varianteId: v.id, prod: p, variante: v, link };
    }
  }
  return null;
}

// ─── Helper: buscar match por tn_variant_id del contenedor ─────────────────
function findMatchByContainerVariant(tn_variant_id) {
  const id = String(tn_variant_id);
  for (const m of db.get('matchs').value()) {
    if (!m.variantMap) continue;
    const vm = m.variantMap.find(v => String(v.tn_variant_id) === id);
    if (vm) return { match: m, vm };
  }
  return null;
}

// Lo que se recorta del log se agrega a un archivo aparte (una línea JSON por movimiento)
const LOG_ARCHIVE = path.join(path.dirname(DB_PATH), 'log-archive.jsonl');
function archiveLog(productoId, varianteId, entries) {
  if (!entries.length) return;
  try {
    fs.appendFileSync(LOG_ARCHIVE, entries.map(e => JSON.stringify({ productoId, varianteId, ...e })).join('\n') + '\n');
  } catch (e) { console.error('[LOG] No se pudo archivar:', e.message); }
}

// Agrega un movimiento al log de la variante (y opcionalmente cambia campos, ej: stock)
function pushLog(productoId, varianteId, entry, patch) {
  const v = getVariantRef(productoId, varianteId).value();
  if (!v) return null;
  if (patch) Object.assign(v, patch);
  if (!Array.isArray(v.log)) v.log = [];
  v.log.unshift({ ts: new Date().toISOString(), ...entry });
  if (v.log.length > LOG_MAX) archiveLog(productoId, varianteId, v.log.splice(LOG_MAX));
  db.write();
  emitChange('activity', { productoId });
  if (patch && 'stock' in patch) emitChange('stock', { productoId });
  return v;
}

// ════════════════════════════════════════════════════════════════════════════
// Núcleo de stock: asignación por canal
// ════════════════════════════════════════════════════════════════════════════
//
// Una variante de SC se vende por varios "canales" de TN:
//   - cada link directo (SKU compartido: varios diseños salen de la misma remera)
//   - cada combo (variante del contenedor de un Match que la incluye)
// TN controla stock por variante: si todos los canales muestran el stock completo,
// un carrito con dos diseños distintos pasa aunque quede 1 sola unidad (bug real:
// remera negra talle 4 con 1 en stock vendió 2).
//
// Regla: las reservas de carrito ("holds") NO descuentan stock físico (así el que
// tiene el producto en el carrito puede pagar), pero se asignan a su canal.
// A cada canal se le empuja a TN:
//        libre + reservado_en_ese_canal        (libre = stock − total reservado)
// El diseño que está en el carrito conserva su unidad y los demás quedan en 0.
// La suma de lo que muestra TN nunca supera el stock real.

// Reserva vigente que retiene stock. Las normales viejas (sin kind) también cuentan;
// las de combo viejas se convierten en migrateDb.
function isHold(r) { return r.kind === 'hold' || (!r.kind && !r.matchReservationId); }

function activeHolds(filterFn) {
  const now = Date.now();
  return db.get('reservations').value().filter(r => isHold(r) && r.expiresAt > now && (!filterFn || filterFn(r)));
}

// Con más de EXACT_BELOW unidades libres no hay riesgo real de sobreventa entre diseños:
// todos los canales muestran el stock completo y un carrito no genera PUTs a TN.
// Cuando lo libre baja a EXACT_BELOW o menos, cada canal recibe exactamente lo suyo.
const EXACT_BELOW = Math.max(0, toNum(process.env.SC_EXACT_BELOW || 3));

function allocation(productoId, varianteId) {
  const v = getVariantRef(productoId, varianteId).value();
  const stock = Math.max(0, toNum(v && v.stock));
  let reserved = 0;
  const byChannel = new Map();
  let left = stock; // si hay más reservado que stock, el stock se reparte por orden de llegada
  const holds = activeHolds(r => r.productoId === productoId && r.varianteId === varianteId)
    .sort((a, b) => toNum(a.createdAt) - toNum(b.createdAt));
  for (const h of holds) {
    const q = toNum(h.qty);
    reserved += q;
    const got = Math.min(q, left);
    left -= got;
    const ch = h.tnVariantId ? String(h.tnVariantId) : '';
    byChannel.set(ch, (byChannel.get(ch) || 0) + got);
  }
  const free = Math.max(0, stock - reserved);
  return { stock, reserved, free, byChannel };
}

function channelStock(alloc, channel) {
  if (alloc.free > EXACT_BELOW) return alloc.stock;
  return Math.max(0, Math.min(alloc.stock, alloc.free + (alloc.byChannel.get(String(channel)) || 0)));
}

// Stock disponible para un carrito nuevo (lo que puede comprar otra persona)
function getAvailableStock(productoId, varianteId) {
  return allocation(productoId, varianteId).free;
}

// Combos (match + variante del contenedor) que usan alguna de estas variantes de TN
function combosForTnVariants(variantIds) {
  const out = [];
  for (const match of db.get('matchs').value()) {
    if (!match.variantMap || !match.tn_match_product_id) continue;
    for (const vm of match.variantMap) {
      if (!vm.tn_variant_id) continue;
      if (variantIds.has(String(vm.v1id)) || variantIds.has(String(vm.v2id))) out.push({ match, vm });
    }
  }
  return out;
}

// Stock de TN de una variante (para lados de combos que no están gestionados en SC)
async function tnVariantStock(productId, variantId, ctx) {
  if (!ctx.products) ctx.products = new Map();
  const pid = String(productId);
  if (!ctx.products.has(pid)) {
    const data = await tnRequest('GET', `/products/${pid}?fields=id,variants`);
    ctx.products.set(pid, new Map((data.variants || []).map(v => [String(v.id), v.stock === null || v.stock === undefined ? null : toNum(v.stock)])));
  }
  return ctx.products.get(pid).get(String(variantId));
}

// Stock que tiene que mostrar el contenedor de un combo: min de los dos lados,
// cada lado calculado desde SC con la reserva del propio combo.
// Devuelve número, null (sin control de stock) o undefined (no se puede calcular).
async function computeComboStock(match, vm, ctx = {}) {
  const sides = [[vm.v1id, match.producto1 && match.producto1.tn_product_id], [vm.v2id, match.producto2 && match.producto2.tn_product_id]];
  const ints = sides.map(([id]) => findInternalByTnVariant(id));
  if (ints[0] && ints[1] && ints[0].productoId === ints[1].productoId && ints[0].varianteId === ints[1].varianteId) {
    // los dos lados salen del mismo stock: cada combo consume 2
    return Math.floor(channelStock(allocation(ints[0].productoId, ints[0].varianteId), vm.tn_variant_id) / 2);
  }
  const vals = [];
  for (let i = 0; i < 2; i++) {
    if (ints[i]) { vals.push(channelStock(allocation(ints[i].productoId, ints[i].varianteId), vm.tn_variant_id)); continue; }
    if (!sides[i][1]) return undefined;
    const s = await tnVariantStock(sides[i][1], sides[i][0], ctx);
    if (s === undefined) return 0; // la variante individual ya no existe en TN: el combo no se puede vender
    if (s !== null) vals.push(s);
  }
  return vals.length ? Math.min(...vals) : null;
}

// Versión sin llamadas a TN (para el panel): lados no gestionados usan el último valor conocido
function comboStockLocal(match, vm) {
  const ints = [findInternalByTnVariant(vm.v1id), findInternalByTnVariant(vm.v2id)];
  if (!ints[0] || !ints[1]) return vm.tn_stock === undefined ? null : vm.tn_stock;
  if (ints[0].productoId === ints[1].productoId && ints[0].varianteId === ints[1].varianteId) {
    return Math.floor(channelStock(allocation(ints[0].productoId, ints[0].varianteId), vm.tn_variant_id) / 2);
  }
  return Math.min(...ints.map(x => channelStock(allocation(x.productoId, x.varianteId), vm.tn_variant_id)));
}

// ─── Sync a Tiendanube (cola global, una variante a la vez) ─────────────────
// Serializar evita que dos syncs de la misma variante se pisen con valores viejos;
// si llega otro pedido mientras corre, se agrupa y corre una vez más al final.
const syncQueue = new Map();
let syncRunning = false;

function syncVariante(productoId, varianteId, onProgress, opts = {}) {
  const key = `${productoId}|${varianteId}`;
  return new Promise((resolve, reject) => {
    let entry = syncQueue.get(key);
    if (!entry) {
      entry = { productoId, varianteId, forceAll: false, force: new Set(), progress: [], waiters: [] };
      syncQueue.set(key, entry);
    }
    if (opts.force === true) entry.forceAll = true;
    else if (opts.force) for (const f of opts.force) entry.force.add(String(f));
    if (onProgress) entry.progress.push(onProgress);
    entry.waiters.push({ resolve, reject });
    drainSyncQueue();
  });
}

async function drainSyncQueue() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (syncQueue.size > 0) {
      const [key, entry] = syncQueue.entries().next().value;
      syncQueue.delete(key);
      try {
        const r = await doSyncVariante(entry);
        entry.waiters.forEach(w => w.resolve(r));
      } catch (e) {
        entry.waiters.forEach(w => w.reject(e));
      }
    }
  } finally {
    syncRunning = false;
  }
}

async function doSyncVariante({ productoId, varianteId, forceAll, force, progress }) {
  const prod = db.get('productos').find({ id: productoId }).value();
  if (!prod) throw new Error('Producto no encontrado');
  const variante = (prod.variantes || []).find(v => v.id === varianteId);
  if (!variante) throw new Error('Variante no encontrada');
  const links = variante.links || [];
  const combos = combosForTnVariants(new Set(links.map(l => String(l.variant_id))));
  const total = links.length + combos.length;
  const notify = (p) => progress.forEach(fn => { try { fn(p); } catch (_) { /* listener roto */ } });
  // Solo se hace PUT si cambió respecto de lo último empujado (o si se fuerza / hubo error)
  const mustPush = (id, cached, value, hadError) => forceAll || force.has(String(id)) || cached !== value || hadError;
  const errors = [];
  let updated = 0, current = 0, combosUpdated = 0;
  const now = () => new Date().toISOString();

  for (const link of links) {
    const value = channelStock(allocation(productoId, varianteId), link.variant_id);
    let ok = true;
    if (link.missing_in_tn && !forceAll) { notify({ current: ++current, total, label: link.label, ok: false }); continue; }
    if (mustPush(link.variant_id, link.tn_stock, value, !!link.sync_error)) {
      try {
        await tnRequest('PUT', `/products/${link.product_id}/variants/${link.variant_id}`, { stock: value });
        link.tn_stock = value; link.tn_synced_at = now(); delete link.sync_error;
        updated++;
      } catch (e) {
        ok = false;
        link.sync_error = e.message;
        if (e.status === 404) link.missing_in_tn = true;
        errors.push({ variant_id: link.variant_id, label: link.label, error: e.status === 404 ? 'Esa variante ya no existe en Tiendanube (desvinculala o volvé a importarla)' : e.message });
      }
    }
    notify({ current: ++current, total, label: link.label, ok });
  }

  const ctx = {};
  for (const { match, vm } of combos) {
    let ok = true;
    try {
      const value = await computeComboStock(match, vm, ctx);
      if (value !== undefined && mustPush(vm.tn_variant_id, vm.tn_stock, value, !!vm.sync_error)) {
        await tnRequest('PUT', `/products/${match.tn_match_product_id}/variants/${vm.tn_variant_id}`, { stock: value });
        vm.tn_stock = value; delete vm.sync_error;
        combosUpdated++;
      }
    } catch (e) {
      ok = false;
      vm.sync_error = e.message;
      errors.push({ variant_id: vm.tn_variant_id, label: `${match.nombre} · ${vm.label}`, error: e.message });
    }
    notify({ current: ++current, total, label: `${match.nombre} · ${vm.label}`, ok });
  }
  db.write();

  if (updated > 0 || combosUpdated > 0 || errors.length > 0) {
    pushLog(productoId, varianteId, {
      action: 'sync', stock: toNum(variante.stock),
      links_updated: updated, combos_updated: combosUpdated || undefined,
      errors: errors.length > 0 ? errors : undefined
    });
  }
  const alertKey = `sync_error|${productoId}|${varianteId}`;
  if (errors.length > 0) {
    addAlert({
      key: alertKey, type: 'sync_error', severity: 'error', reopen: true,
      title: `No se pudo actualizar Tiendanube: ${prod.nombre} · ${variante.label}`,
      detail: errors.slice(0, 3).map(e => `${e.label}: ${e.error}`).join(' | ') + (errors.length > 3 ? ` (+${errors.length - 3})` : ''),
      productoId, varianteId
    });
  } else {
    resolveAlert(alertKey);
  }
  emitChange('stock', { productoId });
  return { ok: errors.length === 0, updated, combos_updated: combosUpdated, total, errors };
}

// ─── Helper: chequear si una orden ya descontó stock de una variante ────────
// Idempotencia por (order_id + variante interna + tn_variant_id): si una orden
// tiene 2 line items de TN distintos que caen en la misma variante interna (SKU
// compartido), ambos descuentan; el retry del MISMO line item no repite.
// El estado vive en db.order_items (no en el log, que se recorta).
function itemKey(order_id, productoId, varianteId, tn_variant_id) {
  return `${order_id}|${productoId}|${varianteId}|${tn_variant_id || ''}`;
}
function getItemRecord(order_id, productoId, varianteId, tn_variant_id) {
  const items = db.get('order_items').value();
  return items[itemKey(order_id, productoId, varianteId, tn_variant_id)]
    // ventas viejas (antes del fix de SKU compartido) se guardaron sin tn_variant_id
    || items[itemKey(order_id, productoId, varianteId, '')]
    || null;
}
function setItemRecord(order_id, productoId, varianteId, tn_variant_id, patch) {
  const items = db.get('order_items').value();
  const key = itemKey(order_id, productoId, varianteId, tn_variant_id);
  items[key] = { ...(items[key] || {}), ...patch, ts: new Date().toISOString() };
  db.write();
}
function orderAlreadyDiscounted(productoId, varianteId, order_id, tn_variant_id) {
  const r = getItemRecord(String(order_id), productoId, varianteId, tn_variant_id);
  return !!r && (r.state === 'sold' || r.state === 'returned');
}

// ─── Reservas (holds) ────────────────────────────────────────────────────────
const DUPLICATE_ADD_MS = 3000; // el storefront tiene varios hooks: el mismo "agregar" puede llegar repetido

// Intenta reservar `qty` en cada lado (1 lado = producto normal, 2 = combo) para el canal dado.
// Todo o nada: si un lado no tiene disponible, no se reserva ninguno.
function placeHolds(sessionId, sides, channel, meta = {}) {
  const now = Date.now();
  const sessionShort = String(sessionId).slice(0, 8);
  const failing = [];
  const plan = [];
  for (const side of sides) {
    const alloc = allocation(side.productoId, side.varianteId);
    const existing = db.get('reservations').value().find(r =>
      isHold(r) && r.expiresAt > now && r.sessionId === sessionId &&
      String(r.tnVariantId || '') === String(channel) && r.productoId === side.productoId && r.varianteId === side.varianteId);
    if (existing && existing.lastAddAt && now - existing.lastAddAt < DUPLICATE_ADD_MS && toNum(existing.lastAddQty) === side.qty) {
      return { ok: true, duplicate: true, ids: [existing.id] };
    }
    if (alloc.free < side.qty) failing.push({ side, available: alloc.free });
    plan.push({ side, existing });
  }

  if (failing.length > 0) {
    for (const { side, available } of failing) {
      const reason = `Sesión ${sessionShort} · ${meta.ip || '?'} · quiso ${side.qty}${meta.label ? ` (${meta.label})` : ''}, disponible ${available}`;
      pushLog(side.productoId, side.varianteId, {
        action: 'cart_rejected', session_id: sessionId, tn_variant_id: String(channel),
        delta: 0, stock: toNum(side.variante.stock), reason
      });
      addAlert({
        key: `cart_rejected|${side.productoId}|${side.varianteId}`, type: 'cart_rejected', severity: 'warning', reopen: true,
        title: `Carrito rechazado por falta de stock: ${side.prod.nombre} · ${side.variante.label}`,
        detail: `Alguien quiso agregar ${side.qty}${meta.label ? ` (${meta.label})` : ''} y quedaban ${available} libres. Tiendanube se corrigió para que no se pueda.`,
        productoId: side.productoId, varianteId: side.varianteId, variant_id: String(channel)
      });
      // Si TN dejó agregarlo es porque tenía un número viejo: forzar el canal
      syncVariante(side.productoId, side.varianteId, null, { force: [channel] }).catch(e => console.error('[RESERVAS] Sync error:', e.message));
    }
    return { ok: false, available: Math.min(...failing.map(f => f.available)) };
  }

  const ids = [];
  let accumulated = false;
  for (const { side, existing } of plan) {
    let id;
    let qtyTotal = side.qty;
    if (existing) {
      existing.qty = toNum(existing.qty) + side.qty;
      existing.expiresAt = now + RESERVATION_MS;
      existing.lastAddAt = now; existing.lastAddQty = side.qty;
      qtyTotal = existing.qty;
      id = existing.id;
      accumulated = true;
      db.write();
    } else {
      id = `res_${meta.matchId ? 'match_' : ''}${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      db.get('reservations').push({
        id, kind: 'hold', sessionId,
        productoId: side.productoId, varianteId: side.varianteId,
        tnVariantId: String(channel),
        qty: side.qty, expiresAt: now + RESERVATION_MS, createdAt: now,
        lastAddAt: now, lastAddQty: side.qty,
        comboGroupId: meta.comboGroupId || null,
        matchId: meta.matchId || null
      }).write();
    }
    ids.push(id);
    const prefix = meta.matchName ? `[COMBO ${meta.matchName}] ` : '';
    pushLog(side.productoId, side.varianteId, {
      action: 'cart_added', reservation_id: id, session_id: sessionId, tn_variant_id: String(channel),
      delta: 0, stock: toNum(side.variante.stock),
      reason: `${prefix}Sesión ${sessionShort} · ${meta.ip || '?'} · ${existing ? `+${side.qty} (carrito, qty ${qtyTotal})` : `carrito (qty ${side.qty})`}`
    });
    // Re-asignar canales en TN (el resto de los diseños baja si se acabó lo libre)
    syncVariante(side.productoId, side.varianteId).catch(e => console.error('[RESERVAS] Sync error:', e.message));
  }
  emitChange('stock', {});
  return { ok: true, ids, accumulated };
}

// Saca reservas y re-sincroniza las variantes afectadas
function dropHolds(holds, action, reasonFn) {
  if (holds.length === 0) return 0;
  const ids = new Set(holds.map(h => h.id));
  db.get('reservations').remove(r => ids.has(r.id)).write();
  const touched = new Map();
  for (const h of holds) {
    const v = getVariantRef(h.productoId, h.varianteId).value();
    if (!v) continue;
    pushLog(h.productoId, h.varianteId, {
      action, reservation_id: h.id, session_id: h.sessionId, tn_variant_id: h.tnVariantId || undefined,
      delta: 0, stock: toNum(v.stock), reason: reasonFn(h)
    });
    touched.set(`${h.productoId}|${h.varianteId}`, h);
  }
  for (const h of touched.values()) {
    syncVariante(h.productoId, h.varianteId).catch(e => console.error('[RESERVAS] Sync error:', e.message));
  }
  emitChange('stock', {});
  return holds.length;
}

function holdLabel(h) {
  const m = h.matchId ? db.get('matchs').find({ id: h.matchId }).value() : null;
  return m ? `Combo ${m.nombre} · ` : '';
}

// Consume reservas del canal vendido (las del mismo canal; las de otros diseños se respetan)
function consumeHolds(productoId, varianteId, channel, qty) {
  const now = Date.now();
  const candidates = db.get('reservations').value()
    .filter(r => isHold(r) && r.expiresAt > now && r.productoId === productoId && r.varianteId === varianteId
      && (String(r.tnVariantId || '') === String(channel) || !r.tnVariantId))
    .sort((a, b) => (toNum(b.qty) === qty) - (toNum(a.qty) === qty) || toNum(a.createdAt) - toNum(b.createdAt));
  let left = qty;
  const consumed = [];
  for (const r of candidates) {
    if (left <= 0) break;
    const q = toNum(r.qty);
    if (q <= left) {
      db.get('reservations').remove({ id: r.id }).value();
      left -= q;
      consumed.push(r.id);
    } else {
      r.qty = q - left;
      left = 0;
      consumed.push(r.id);
    }
  }
  db.write();
  return consumed;
}

// ─── Cron: liberar reservas expiradas cada 60 seg ───────────────────────────
async function releaseExpiredReservations() {
  const now = Date.now();
  const expired = db.get('reservations').value().filter(r => r.expiresAt <= now);
  if (expired.length === 0) return 0;
  console.log(`[RESERVAS] Liberando ${expired.length} reserva(s) expirada(s)...`);
  return dropHolds(expired, 'cart_expired',
    h => `${holdLabel(h)}Sesión ${h.sessionId ? String(h.sessionId).slice(0, 8) : '?'} · Carrito abandonado (30 min)`);
}

// ─── Migración de datos (corre al arrancar, es idempotente) ─────────────────
function migrateDb() {
  // 1. Índice de idempotencia de órdenes a partir de los logs (antes vivía solo en el log)
  if (!db.get('meta.order_items_backfilled').value()) {
    const items = db.get('order_items').value();
    for (const p of db.get('productos').value()) {
      for (const v of p.variantes || []) {
        const returned = new Set();
        for (const e of v.log || []) if (e.action === 'return' && e.order_id) returned.add(String(e.order_id));
        for (const e of v.log || []) {
          if (e.action !== 'sale' || !e.order_id) continue;
          const key = itemKey(String(e.order_id), p.id, v.id, e.tn_variant_id || '');
          items[key] = { state: returned.has(String(e.order_id)) ? 'returned' : 'sold', qty: Math.abs(toNum(e.delta)), ts: e.ts, backfilled: true };
        }
      }
    }
    db.set('meta.order_items_backfilled', true).write();
  }

  // 2. Reservas viejas → modo "hold". Las de combos descontaban stock: se devuelve
  //    y pasan a retener por canal (el contenedor del combo, si se puede deducir).
  const reservations = db.get('reservations').value();
  const legacyByGroup = new Map();
  for (const r of reservations) {
    if (r.kind) continue;
    if (r.matchReservationId) {
      if (!legacyByGroup.has(r.matchReservationId)) legacyByGroup.set(r.matchReservationId, []);
      legacyByGroup.get(r.matchReservationId).push(r);
    } else {
      r.kind = 'hold';
      r.createdAt = r.createdAt || Date.now();
    }
  }
  for (const group of legacyByGroup.values()) {
    const ids = new Set(group.map(r => String(r.tnVariantId)));
    let channel = null;
    for (const m of db.get('matchs').value()) {
      const vm = (m.variantMap || []).find(x => ids.has(String(x.v1id)) && (ids.size === 1 || ids.has(String(x.v2id))));
      if (vm && group.length === 2) { channel = String(vm.tn_variant_id); break; }
    }
    for (const r of group) {
      const v = getVariantRef(r.productoId, r.varianteId).value();
      if (v) {
        const newStock = toNum(v.stock) + toNum(r.qty);
        v.stock = newStock;
        if (!Array.isArray(v.log)) v.log = [];
        v.log.unshift({
          ts: new Date().toISOString(), action: 'reservation_released', reservation_id: r.id,
          delta: +toNum(r.qty), stock: newStock,
          reason: 'Migración: la reserva de combo deja de descontar stock (ahora retiene la unidad en el carrito)'
        });
      }
      r.kind = 'hold';
      r.tnVariantId = channel;
      r.createdAt = r.createdAt || Date.now();
    }
  }
  db.write();
}

// ─── Re-sincronizar TODOS los combos (endpoint admin, tarea y cron) ─────────
// Lee el stock actual de cada contenedor en TN y actualiza solo los combos cuyo
// valor difiere de lo que corresponde según SC (min de los dos lados).
async function resyncAllMatchs(onProgress) {
  const matchs = db.get('matchs').value();
  const results = [];
  const ctx = {};
  for (let i = 0; i < matchs.length; i++) {
    const match = matchs[i];
    if (onProgress) onProgress({ current: i, total: matchs.length, message: match.nombre });
    if (!match.tn_match_product_id || !match.variantMap) {
      results.push({ id: match.id, nombre: match.nombre, skipped: true, reason: 'sin tn_match_product_id o variantMap' });
      continue;
    }
    try {
      const container = await tnRequest('GET', `/products/${match.tn_match_product_id}?fields=id,variants`);
      const actual = new Map((container.variants || []).map(v => [String(v.id), v.stock === null || v.stock === undefined ? null : toNum(v.stock)]));
      let updated = 0, missing = 0;
      const changes = [];
      const errors = [];
      for (const vm of match.variantMap) {
        if (!actual.has(String(vm.tn_variant_id))) { missing++; continue; }
        try {
          const value = await computeComboStock(match, vm, ctx);
          if (value === undefined) continue;
          const before = actual.get(String(vm.tn_variant_id));
          if (before !== value) {
            await tnRequest('PUT', `/products/${match.tn_match_product_id}/variants/${vm.tn_variant_id}`, { stock: value });
            updated++;
            changes.push({ label: vm.label, old: before, new: value });
          }
          vm.tn_stock = value; delete vm.sync_error;
        } catch (e) {
          vm.sync_error = e.message;
          errors.push({ label: vm.label, error: e.message });
        }
      }
      db.write();
      results.push({ id: match.id, nombre: match.nombre, updated, changes_count: changes.length, changes, missing_in_tn: missing, errors });
    } catch (e) {
      results.push({ id: match.id, nombre: match.nombre, error: e.message });
      console.error(`[RESYNC-MATCHS] Error en "${match.nombre}":`, e.message);
    }
  }
  if (onProgress) onProgress({ current: matchs.length, total: matchs.length, message: 'Listo' });
  emitChange('matchs');
  const totalUpdated = results.reduce((a, r) => a + (r.updated || 0), 0);
  return { total_matchs: matchs.length, processed: results.length, total_updated: totalUpdated, results };
}

// Todas las variantes de TN con su stock, en bloque (200 por página)
async function fetchAllTnVariantStocks() {
  const map = new Map();
  for (let page = 1; page < 200; page++) {
    let batch;
    try {
      batch = await tnRequest('GET', `/products?per_page=200&page=${page}&fields=id,variants`);
    } catch (e) {
      if (/last page is/i.test(e.message) || e.status === 404) break;
      throw e;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const p of batch) {
      for (const v of p.variants || []) {
        map.set(String(v.id), { product_id: String(p.id), stock: v.stock === null || v.stock === undefined ? null : toNum(v.stock) });
      }
    }
    if (batch.length < 200) break;
  }
  return map;
}

// ─── Reconciliación SC → TN: SC es la fuente de verdad ──────────────────────
// Compara lo que muestra TN en cada producto vinculado con lo que corresponde
// según SC; si difiere, corrige TN (no SC) y deja una alerta para revisar.
async function reconcileProducts(onProgress) {
  const tnStocks = await fetchAllTnVariantStocks();
  const productos = db.get('productos').value();
  let chequeados = 0, corregidos = 0, errores = 0, faltantes = 0;
  const total = productos.reduce((a, p) => a + (p.variantes || []).length, 0);
  let current = 0;
  for (const prod of productos) {
    for (const variante of prod.variantes || []) {
      if (onProgress) onProgress({ current: current++, total, message: `${prod.nombre} · ${variante.label}` });
      for (const link of variante.links || []) {
        const actual = tnStocks.get(String(link.variant_id));
        if (!actual) { faltantes++; link.missing_in_tn = true; continue; }
        delete link.missing_in_tn;
        chequeados++;
        const expected = channelStock(allocation(prod.id, variante.id), link.variant_id);
        if (actual.stock === expected) { link.tn_stock = expected; continue; }
        try {
          await tnRequest('PUT', `/products/${link.product_id}/variants/${link.variant_id}`, { stock: expected });
          link.tn_stock = expected; delete link.sync_error;
          corregidos++;
          console.log(`[RECONCILIAR] ${prod.nombre}/${variante.label} (${link.label}): TN ${actual.stock} → ${expected}`);
          addAlert({
            key: `discrepancy|${prod.id}|${variante.id}|${link.variant_id}`, type: 'discrepancy', severity: 'warning', reopen: true,
            title: `Tiendanube tenía otro stock: ${prod.nombre} · ${variante.label}`,
            detail: `${link.label}: TN mostraba ${actual.stock === null ? 'sin control de stock' : actual.stock}, SC dice ${expected}. Se corrigió Tiendanube.`,
            productoId: prod.id, varianteId: variante.id, variant_id: String(link.variant_id)
          });
        } catch (e) {
          errores++;
          link.sync_error = e.message;
          console.warn(`[RECONCILIAR] Error corrigiendo ${prod.nombre}/${variante.label}:`, e.message);
        }
      }
    }
  }
  db.write();
  emitChange('stock', {});
  return { chequeados, corregidos, errores, faltantes };
}

// ─── Revisión de órdenes: procesa las que no llegaron por webhook ───────────
// Se responde 200 al webhook antes de procesar: si el server se reinicia en el
// medio (deploy), el evento se pierde. Esto lo recupera. Es idempotente.
// Nunca procesa órdenes anteriores a la primera vez que corrió (catchup_since).
async function catchUpOrders(onProgress) {
  const since0 = db.get('meta.catchup_since').value();
  if (!since0) {
    setMeta('catchup_since', new Date().toISOString());
    return { first_run: true, revisadas: 0, procesadas: 0 };
  }
  const floor = Date.parse(since0);
  const since = new Date(Math.max(floor, Date.now() - 3 * 86400e3)).toISOString();
  let revisadas = 0, procesadas = 0;
  for (let page = 1; page < 100; page++) {
    let batch;
    try {
      batch = await tnRequest('GET', `/orders?updated_at_min=${encodeURIComponent(since)}&per_page=50&page=${page}`);
    } catch (e) {
      if (/last page is/i.test(e.message) || e.status === 404) break;
      throw e;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const order of batch) {
      revisadas++;
      if (onProgress) onProgress({ current: revisadas, total: revisadas, message: `Orden #${order.number || order.id}` });
      if (Date.parse(order.created_at) < floor) continue;
      const event = order.status === 'cancelled' ? 'order/cancelled' : 'order/created';
      try {
        const r = await processOrderEvent(event, order.id, order, { source: 'catchup' });
        if (r && r.changed) procesadas++;
      } catch (e) { console.warn(`[CATCHUP] Orden ${order.id}:`, e.message); }
    }
    if (batch.length < 50) break;
  }
  setMeta('last_catchup_at', new Date().toISOString());
  if (procesadas > 0) console.log(`[CATCHUP] ${procesadas} línea(s) de órdenes recuperadas`);
  return { revisadas, procesadas };
}

// ─── Ciclo completo (cron 6h y tarea manual) ─────────────────────────────────
async function runReconcileCycle(onProgress) {
  const step = (n, message) => onProgress && onProgress({ current: n, total: 4, message });
  const summary = {};
  console.log('[RECONCILIAR] Iniciando ciclo...');
  step(0, 'Revisando órdenes recientes');
  try { summary.ordenes = await catchUpOrders(); } catch (e) { summary.ordenes = { error: e.message }; }
  step(1, 'Comparando stock con Tiendanube');
  try { summary.productos = await reconcileProducts(); } catch (e) { summary.productos = { error: e.message }; console.error('[RECONCILIAR] Error:', e.message); }
  step(2, 'Agregando talles faltantes a combos');
  try {
    const r = await repairAllMatchVariants();
    summary.repair = { total_added: r.total_added, total_failed: r.total_failed, total_missing: r.total_missing };
  } catch (e) { summary.repair = { error: e.message }; console.error('[REPAIR-MATCHS] Error general:', e.message); }
  step(3, 'Actualizando stock de combos');
  try {
    const r = await resyncAllMatchs();
    summary.matchs = { processed: r.processed, total_updated: r.total_updated };
  } catch (e) { summary.matchs = { error: e.message }; console.error('[RESYNC-MATCHS] Error general:', e.message); }
  step(4, 'Listo');
  setMeta('last_reconcile_at', new Date().toISOString());
  setMeta('last_reconcile', summary);
  console.log('[RECONCILIAR] Ciclo completo:', JSON.stringify(summary));
  return summary;
}

// ════════════════════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  const c = db.get('config').value();
  res.json({ store_id: c.store_id, has_token: !!c.access_token, webhook_registered: c.webhook_registered });
});
app.post('/api/config', (req, res) => {
  const { access_token, store_id } = req.body;
  if (!access_token || !store_id) return res.status(400).json({ error: 'Faltan datos' });
  db.set('config.access_token', access_token).set('config.store_id', store_id).write();
  res.json({ ok: true });
});
app.post('/api/config/test', async (req, res) => {
  try {
    const s = await tnRequest('GET', '/store');
    const name = s && s.name ? (typeof s.name === 'object' ? (s.name.es || Object.values(s.name)[0]) : s.name) : '';
    res.json({ ok: true, store_name: name ? `Conectado a ${name}` : 'Tienda conectada OK' });
  }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/config/webhook', async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Falta webhook_url' });
  try {
    await tnRequest('POST', '/webhooks', { event: 'order/created', url: `${webhook_url}/webhook/order` });
    await tnRequest('POST', '/webhooks', { event: 'order/paid', url: `${webhook_url}/webhook/order` });
    await tnRequest('POST', '/webhooks', { event: 'order/cancelled', url: `${webhook_url}/webhook/order` });
    db.set('config.webhook_registered', true).write();
    res.json({ ok: true, message: 'Webhooks registrados' });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /api/admin/webhooks — listar webhooks registrados en TN
app.get('/api/admin/webhooks', async (req, res) => {
  try {
    const hooks = await tnRequest('GET', '/webhooks');
    res.json(hooks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/webhooks/clean-and-register — borra todos los webhooks y los registra desde cero
// Útil cuando hay duplicados o webhooks viejos apuntando a URLs que ya no existen
app.post('/api/admin/webhooks/clean-and-register', async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Falta webhook_url' });
  try {
    // 1. Listar y borrar todos los webhooks existentes
    const existing = await tnRequest('GET', '/webhooks');
    const deleted = [];
    for (const h of existing) {
      try {
        await tnRequest('DELETE', `/webhooks/${h.id}`);
        deleted.push({ id: h.id, event: h.event, url: h.url });
      } catch (e) { console.warn(`No se pudo borrar webhook ${h.id}:`, e.message); }
    }
    // 2. Registrar los 3 que necesitamos
    const registered = [];
    for (const event of ['order/created', 'order/paid', 'order/cancelled']) {
      try {
        const w = await tnRequest('POST', '/webhooks', { event, url: `${webhook_url}/webhook/order` });
        registered.push({ event, id: w.id });
      } catch (e) { registered.push({ event, error: e.message }); }
    }
    db.set('config.webhook_registered', true).write();
    res.json({ ok: true, deleted, registered });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Productos
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/productos', (req, res) => {
  if (req.query.lite && req.query.lite !== '0') return res.json(productosLite());
  res.json(db.get('productos').value());
});

app.post('/api/productos', (req, res) => {
  const { id, nombre } = req.body;
  if (!id || !nombre) return res.status(400).json({ error: 'Faltan id o nombre' });
  const slug = id.toUpperCase().replace(/\s+/g, '_');
  if (db.get('productos').find({ id: slug }).value()) return res.status(409).json({ error: 'Ya existe' });
  const nuevo = { id: slug, nombre, variantes: [] };
  db.get('productos').push(nuevo).write();
  res.json(nuevo);
});

app.delete('/api/productos/:id', (req, res) => {
  db.get('productos').remove({ id: req.params.id }).write();
  db.get('reservations').remove(r => r.productoId === req.params.id).write();
  emitChange('stock', {});
  res.json({ ok: true });
});

app.post('/api/productos/:id/sync', async (req, res) => {
  try {
    const prod = db.get('productos').find({ id: req.params.id }).value();
    if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
    const results = [];
    for (const v of prod.variantes) {
      const r = await syncVariante(req.params.id, v.id);
      results.push({ variante: v.label, ...r });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/productos/:id/sync-variantes — importar variantes faltantes desde TN
app.post('/api/productos/:id/sync-variantes', async (req, res) => {
  const prod = db.get('productos').find({ id: req.params.id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });

  try {
    // Buscar el product_id de TN buscando en los links de las variantes existentes
    let tnProductId = null;
    for (const v of prod.variantes) {
      if (v.links && v.links.length > 0) { tnProductId = v.links[0].product_id; break; }
    }
    if (!tnProductId) return res.status(400).json({ error: 'No hay links a TN. Vinculá al menos una variante primero.' });

    // Traer todas las variantes del producto en TN
    const tnProduct = await tnRequest('GET', `/products/${tnProductId}?fields=id,name,variants`);
    const tnVariants = tnProduct.variants || [];

    // Ver qué variant_ids ya están en Stock Central
    const linkedVariantIds = new Set();
    for (const v of prod.variantes) {
      for (const l of v.links) linkedVariantIds.add(l.variant_id);
    }

    // Agregar las que faltan
    const added = [];
    const skipped = [];

    for (const tnV of tnVariants) {
      const tnVId = String(tnV.id);
      if (linkedVariantIds.has(tnVId)) { skipped.push(tnVId); continue; }

      // Construir label de la variante
      const vLabel = tnV.values?.map(vv => Object.values(vv)[0]).join(' / ') || `Variante ${tnV.id}`;
      const pName = typeof tnProduct.name === 'object' ? (tnProduct.name.es || '') : String(tnProduct.name);
      const label = `${pName} · ${vLabel}`;
      const stock = tnV.stock ?? 0;

      // Crear variante en Stock Central
      const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2,4)}`;
      const nueva = {
        id: varId, label: vLabel, stock,
        links: [{ product_id: tnProductId, variant_id: tnVId, label, linked_at: new Date().toISOString() }],
        log: [{ ts: new Date().toISOString(), action: 'created', stock, reason: 'Importada desde TN (sync-variantes)' }]
      };
      db.get('productos').find({ id: req.params.id }).get('variantes').push(nueva).write();
      added.push({ label: vLabel, stock, variant_id: tnVId });
    }

    console.log(`[SYNC-VAR] ${prod.nombre}: +${added.length} variantes importadas, ${skipped.length} ya existían`);
    res.json({ ok: true, added: added.length, skipped: skipped.length, variantes: added });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Variantes internas
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/productos/:id/variantes', (req, res) => {
  const { label, stock } = req.body;
  if (!label) return res.status(400).json({ error: 'Falta label' });
  const prod = db.get('productos').find({ id: req.params.id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const nueva = { id: varId, label, stock: parseInt(stock) || 0, links: [], log: [{ ts: new Date().toISOString(), action: 'created', stock: parseInt(stock) || 0 }] };
  db.get('productos').find({ id: req.params.id }).get('variantes').push(nueva).write();
  res.json(nueva);
});

app.put('/api/productos/:id/variantes/:varId/stock', async (req, res) => {
  const { id, varId } = req.params;
  const { delta, absolute, reason, sync } = req.body;
  const prod = db.get('productos').find({ id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const variante = prod.variantes.find(v => v.id === varId);
  if (!variante) return res.status(404).json({ error: 'Variante no encontrada' });
  const isAbsolute = absolute !== undefined && absolute !== null && absolute !== '';
  if (isAbsolute && !Number.isFinite(Number(absolute))) return res.status(400).json({ error: 'El stock tiene que ser un número' });
  if (!isAbsolute && !Number.isFinite(Number(delta))) return res.status(400).json({ error: 'El ajuste tiene que ser un número' });
  const currentStock = toNum(variante.stock);
  let newStock = Math.round(isAbsolute ? toNum(absolute) : currentStock + toNum(delta));
  if (newStock < 0) newStock = 0;
  pushLog(id, varId, {
    action: isAbsolute ? 'set' : toNum(delta) > 0 ? 'add' : 'subtract',
    delta: newStock - currentStock, stock: newStock, reason: reason || ''
  }, { stock: newStock });
  let syncResult = null;
  if (sync) {
    // Se espera al sync hasta 5 s; si TN tarda más, sigue atrás y los errores llegan por alertas/SSE
    const p = syncVariante(id, varId, null, { force: true });
    const timeout = new Promise(r => setTimeout(() => r(null), 5000));
    try { syncResult = await Promise.race([p, timeout]); } catch (e) { syncResult = { ok: false, error: e.message }; }
    if (syncResult === null) {
      p.catch(e => console.error('[STOCK] Sync en segundo plano:', e.message));
      syncResult = { ok: true, pending: true, updated: 0, total: (variante.links || []).length, errors: [] };
    }
  }
  res.json({ ok: true, stock: newStock, sync: syncResult });
});

app.delete('/api/productos/:id/variantes/:varId', (req, res) => {
  db.get('productos').find({ id: req.params.id }).get('variantes').remove({ id: req.params.varId }).write();
  db.get('reservations').remove(r => r.productoId === req.params.id && r.varianteId === req.params.varId).write();
  emitChange('stock', { productoId: req.params.id });
  res.json({ ok: true });
});

// POST /api/admin/sanitize-stocks — recorrer toda la DB y forzar stocks numéricos
// Soluciona corrupciones tipo "41-37" que quedaron por concatenación de strings
app.post('/api/admin/sanitize-stocks', async (req, res) => {
  const productos = db.get('productos').value();
  const fixed = [];
  for (const prod of productos) {
    for (const variante of prod.variantes) {
      const original = variante.stock;
      const sanitized = toNum(original);
      if (original !== sanitized) {
        db.get('productos').find({ id: prod.id }).get('variantes').find({ id: variante.id })
          .assign({ stock: sanitized }).get('log').unshift({
            ts: new Date().toISOString(), action: 'sanitized',
            delta: 0, stock: sanitized,
            reason: `Saneo: valor corrupto "${original}" → ${sanitized} (revisar manualmente)`
          }).write();
        fixed.push({ producto: prod.nombre, variante: variante.label, original, sanitized });
      }
    }
  }
  console.log(`[ADMIN] Saneo: ${fixed.length} variantes corregidas`);
  res.json({ ok: true, fixed_count: fixed.length, fixed });
});

// POST /api/sync-link — sincronizar un solo link (llamado desde el frontend link a link)
app.post('/api/sync-link', async (req, res) => {
  const { product_id, variant_id, stock } = req.body;
  if (!product_id || !variant_id || stock === undefined) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  try {
    // Un link gestionado siempre recibe lo que corresponde según SC (respeta las reservas por diseño)
    const internal = findInternalByTnVariant(variant_id);
    const value = internal ? channelStock(allocation(internal.productoId, internal.varianteId), variant_id) : stock;
    await tnRequest('PUT', `/products/${product_id}/variants/${variant_id}`, { stock: value });
    if (internal) { internal.link.tn_stock = value; delete internal.link.sync_error; db.write(); }
    res.json({ ok: true, variant_id, stock: value });
  } catch (e) {
    res.status(500).json({ ok: false, variant_id, error: e.message });
  }
});

// POST /api/productos/:id/variantes/:varId/sync — sync con SSE progress
app.post('/api/productos/:id/variantes/:varId/sync', async (req, res) => {
  const useSSE = req.headers.accept === 'text/event-stream';
  if (useSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await syncVariante(req.params.id, req.params.varId, (progress) => {
        sendEvent({ type: 'progress', ...progress });
      }, { force: true });
      sendEvent({ type: 'done', ...result });
    } catch (e) {
      sendEvent({ type: 'error', error: e.message });
    }
    res.end();
    return;
  }
  try { res.json(await syncVariante(req.params.id, req.params.varId, null, { force: true })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Links a Tiendanube
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/productos/:id/variantes/:varId/links', (req, res) => {
  const { id, varId } = req.params;
  const { product_id, variant_id, label } = req.body;
  if (!product_id || !variant_id) return res.status(400).json({ error: 'Faltan datos' });
  const prod = db.get('productos').find({ id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const variante = prod.variantes.find(v => v.id === varId);
  if (!variante) return res.status(404).json({ error: 'Variante no encontrada' });
  const already = findInternalByTnVariant(variant_id);
  if (already) {
    return res.status(409).json({ error: already.varianteId === varId ? 'Ya está vinculada a esta variante' : `Esa variante de Tiendanube ya está vinculada a ${already.prod.nombre} · ${already.variante.label}` });
  }
  db.get('productos').find({ id }).get('variantes').find({ id: varId }).get('links').push({
    product_id: String(product_id), variant_id: String(variant_id), label: label || `P:${product_id} V:${variant_id}`,
    linked_at: new Date().toISOString()
  }).write();
  emitChange('stock', { productoId: id });
  // El producto nuevo de TN pasa a mostrar el stock de SC
  syncVariante(id, varId).catch(e => console.error('[LINK] Sync:', e.message));
  res.json({ ok: true });
});

app.delete('/api/productos/:id/variantes/:varId/links/:variant_id', (req, res) => {
  const { id, varId, variant_id } = req.params;
  db.get('productos').find({ id }).get('variantes').find({ id: varId }).get('links').remove({ variant_id }).write();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Reservas de carrito
// ════════════════════════════════════════════════════════════════════════════

// POST /api/reserve — el storefront llama esto cuando agrega al carrito
// Producto normal: retiene la unidad en el diseño elegido (los demás diseños que
// comparten el stock bajan en TN). Combo: retiene en las dos variantes individuales.
// Si no hay disponible → 409 y no se reserva nada.
app.post('/api/reserve', (req, res) => {
  const { sessionId, variant_id } = req.body || {};
  if (!sessionId || !variant_id) return res.status(400).json({ error: 'Faltan sessionId o variant_id' });
  const rawQty = req.body.qty === undefined || req.body.qty === null ? 1 : Number(req.body.qty);
  if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 50) return res.status(400).json({ error: 'qty tiene que ser un entero entre 1 y 50' });
  const qty = rawQty;
  if (String(sessionId).length > 100) return res.status(400).json({ error: 'sessionId inválido' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'IP desconocida';
  const channel = String(variant_id);

  const internal = findInternalByTnVariant(channel);
  if (internal) {
    const r = placeHolds(String(sessionId), [{ ...internal, qty }], channel, { ip });
    if (!r.ok) return res.status(409).json({ ok: false, error: 'Stock insuficiente', available: r.available });
    console.log(`[RESERVAS] ${r.duplicate ? 'Duplicada (ignorada)' : r.accumulated ? 'Acumulada' : 'Nueva'}: sesión ${String(sessionId).slice(0, 8)} ${internal.prod.nombre}/${internal.variante.label} qty ${qty}`);
    return res.json({ ok: true, managed: true, reservation_id: r.ids[0], updated: !!r.accumulated, duplicate: !!r.duplicate });
  }

  const matchResult = findMatchByContainerVariant(channel);
  if (matchResult) {
    const { match, vm } = matchResult;
    const sides = [];
    for (const tnId of [vm.v1id, vm.v2id]) {
      const int = findInternalByTnVariant(tnId);
      if (!int) { console.warn(`[MATCH-RESERVA] ${match.nombre}: variante ${tnId} no está gestionada en SC, no se retiene`); continue; }
      const same = sides.find(s => s.productoId === int.productoId && s.varianteId === int.varianteId);
      if (same) same.qty += qty; else sides.push({ ...int, qty });
    }
    if (sides.length === 0) return res.json({ ok: true, managed: false, reason: 'Combo sin productos gestionados por Stock Central' });
    const r = placeHolds(String(sessionId), sides, channel, {
      ip, matchId: match.id, matchName: match.nombre, label: vm.label, comboGroupId: `mres_${Date.now()}`
    });
    if (!r.ok) return res.status(409).json({ ok: false, error: 'Stock insuficiente', available: r.available, match: match.nombre, combo: vm.label });
    console.log(`[MATCH-RESERVA] ${match.nombre} | ${vm.label} | sesión ${String(sessionId).slice(0, 8)} qty ${qty}`);
    return res.json({ ok: true, managed: true, match: match.nombre, combo: vm.label, reservation_ids: r.ids });
  }
  return res.json({ ok: true, managed: false, reason: 'Variante no gestionada por Stock Central' });
});

// DELETE /api/reserve/:sessionId — liberar reserva (cliente vacía carrito o saca un producto)
app.delete('/api/reserve/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { variant_id } = req.query;
  let toRelease;
  if (variant_id) {
    const channel = String(variant_id);
    toRelease = activeHolds(r => r.sessionId === sessionId && String(r.tnVariantId || '') === channel);
    if (toRelease.length === 0) {
      // reservas viejas sin canal: buscar por la variante interna
      const internal = findInternalByTnVariant(channel);
      if (internal) toRelease = activeHolds(r => r.sessionId === sessionId && !r.tnVariantId && r.productoId === internal.productoId && r.varianteId === internal.varianteId);
    }
  } else {
    toRelease = activeHolds(r => r.sessionId === sessionId);
  }
  const released = dropHolds(toRelease, 'cart_released',
    h => `${holdLabel(h)}Sesión ${h.sessionId ? String(h.sessionId).slice(0, 8) : '?'} · Carrito vaciado`);
  if (released) console.log(`[RESERVAS] Liberadas ${released} reserva(s) de sesión ${sessionId}`);
  res.json({ ok: true, released });
});

// ════════════════════════════════════════════════════════════════════════════
// TN Products list
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/tn-products', async (req, res) => {
  try {
    let all = [], page = 1;
    while (true) {
      let batch;
      try {
        batch = await tnRequest('GET', `/products?per_page=50&page=${page}&fields=id,name,variants`);
      } catch (e) {
        // TN responde "Last page is N" cuando se pide una página más allá de la última
        if (/last page is/i.test(e.message)) break;
        throw e;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < 50) break;
      page++;
    }
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Webhook de órdenes
// ════════════════════════════════════════════════════════════════════════════

app.post('/webhook/order', (req, res) => {
  // Verificación HMAC opcional: si TN_APP_SECRET está configurado, se rechazan webhooks no firmados por TN
  const secret = process.env.TN_APP_SECRET;
  if (secret) {
    const sig = String(req.headers['x-linkedstore-hmac-sha256'] || req.headers['http_x_linkedstore_hmac_sha256'] || '');
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    if (!sig || !safeEqual(sig, expected)) {
      console.warn('[WEBHOOK] Firma inválida, ignorado');
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  const { event, id: order_id } = req.body || {};
  processOrderEvent(event, order_id).catch(e => console.error('[WEBHOOK] Error:', e.message));
});

const ORDER_EVENTS = new Set(['order/created', 'order/paid', 'order/cancelled']);

// Procesa un evento de orden (order/created | order/paid | order/cancelled).
// Separado del endpoint para poder esperarlo (tests, revisión de órdenes).
// Devuelve { changed } = true si movió stock.
async function processOrderEvent(event, order_id, preloadedOrder, opts = {}) {
  if (!ORDER_EVENTS.has(event) || !order_id) {
    console.log(`[WEBHOOK] Evento ignorado: ${event} ${order_id || ''}`);
    return { ignored: true, changed: false };
  }
  if (opts.source !== 'catchup') console.log(`[WEBHOOK] ${event} | Orden: ${order_id}`);
  let order;
  try {
    order = preloadedOrder || await tnRequest('GET', `/orders/${order_id}`);
  } catch (e) {
    addAlert({
      key: `webhook_error|${order_id}|${event}`, type: 'webhook_error', severity: 'error',
      title: `No se pudo leer la orden #${order_id}`,
      detail: `${event}: ${e.message}. Se vuelve a intentar sola en la próxima revisión de órdenes.`,
      order_id: String(order_id)
    });
    throw e;
  }
  if (opts.source !== 'catchup') setMeta('last_webhook_at', new Date().toISOString());

  const ctx = {
    event, order, source: opts.source || 'webhook',
    order_id: String(order_id),
    order_number: order.number ? String(order.number) : undefined,
    cliente: order.contact_name || (order.customer ? `${order.customer.name || ''} ${order.customer.last_name || ''}`.trim() : '') || 'Desconocido',
    email: order.contact_email || order.customer?.email || '',
    createdAt: Date.parse(order.created_at) || null,
    changed: false
  };

  // Un order/cancelled solo devuelve stock si la orden (leída de TN, no del body) está cancelada
  if (event === 'order/cancelled' && order.status && order.status !== 'cancelled') {
    console.warn(`[WEBHOOK] order/cancelled de la orden ${order_id} pero en TN figura "${order.status}". Ignorado.`);
    return { ignored: true, changed: false };
  }

  if (event !== 'order/cancelled' && order.status === 'cancelled') {
    // TN reintentó un created/paid de una orden que ya se canceló: si descontó antes, devolver
    event = 'order/cancelled';
    ctx.event = event;
  }

  for (const item of order.products || []) {
    if (item.variant_id === null || item.variant_id === undefined) continue;
    const qty = Math.max(0, Math.floor(toNum(item.quantity)));
    if (!qty) continue;
    const tnVar = String(item.variant_id);
    // Un error en una línea no corta las demás
    try {
      const internal = findInternalByTnVariant(tnVar);
      if (internal) { await processDirectItem(ctx, item, tnVar, qty, internal); continue; }

      const matchResult = findMatchByContainerVariant(tnVar);
      if (matchResult) { await processComboItem(ctx, item, tnVar, qty, matchResult.match, matchResult.vm); continue; }
    } catch (e) {
      console.error(`[WEBHOOK] Orden ${order_id} línea ${tnVar}:`, e.message);
      addAlert({
        key: `webhook_error|${ctx.order_id}|${tnVar}`, type: 'webhook_error', severity: 'error',
        title: `Error procesando la orden #${ctx.order_number || ctx.order_id}`,
        detail: `Línea ${item.name || tnVar}: ${e.message}`, order_id: ctx.order_id, variant_id: tnVar
      });
      continue;
    }

    if (event !== 'order/cancelled') {
      console.log(`[WEBHOOK] variant_id ${tnVar} no gestionada. Ignorado.`);
      addAlert({
        key: `unlinked_sale|${ctx.order_id}|${tnVar}`, type: 'unlinked_sale', severity: 'warning', once: true,
        title: `Venta sin capturar: ${item.name || `variante ${tnVar}`}`,
        detail: `Orden #${ctx.order_number || ctx.order_id} (${ctx.cliente}) · ${qty}u. Ese producto de Tiendanube no está vinculado a ningún stock de SC: el stock no se descontó.`,
        order_id: ctx.order_id, variant_id: tnVar, product_id: item.product_id ? String(item.product_id) : undefined
      });
    }
  }
  return { changed: ctx.changed };
}

function saleReason(ctx, text, prefix = '') {
  return `${prefix}${ctx.cliente}${ctx.email ? ' · ' + ctx.email : ''} — ${text} (orden #${ctx.order_id})`;
}

function flagOversold(ctx, side, qty, before, itemName) {
  const { productoId, varianteId } = side;
  const prod = db.get('productos').find({ id: productoId }).value();
  const v = getVariantRef(productoId, varianteId).value();
  if (!prod || !v) return;
  pushLog(productoId, varianteId, {
    action: 'oversold', order_id: ctx.order_id, order_number: ctx.order_number, delta: 0, stock: toNum(v.stock),
    reason: `Sobreventa: la orden #${ctx.order_id} pidió ${qty} y había ${before}`
  });
  addAlert({
    key: `oversold|${ctx.order_id}|${productoId}|${varianteId}|${side.tnVar}`, type: 'oversold', severity: 'error', once: true,
    title: `Sobreventa: ${prod.nombre} · ${v.label}`,
    detail: `La orden #${ctx.order_number || ctx.order_id} (${ctx.cliente}${ctx.email ? ', ' + ctx.email : ''}) pidió ${qty}${itemName ? ` de ${itemName}` : ''} y había ${before}. Revisá si la podés cumplir o avisale al cliente.`,
    order_id: ctx.order_id, productoId, varianteId, variant_id: side.tnVar
  });
}

// Venta / cancelación de un producto vinculado directo (incluye SKU compartido)
async function processDirectItem(ctx, item, tnVar, qty, internal) {
  const { productoId, varianteId, prod, link } = internal;
  if (ctx.event !== 'order/cancelled' && link.linked_at && ctx.createdAt && ctx.createdAt < Date.parse(link.linked_at)) {
    console.log(`[WEBHOOK] Orden ${ctx.order_id}: ${tnVar} se vinculó después de la orden, no se descuenta.`);
    return;
  }
  const rec = getItemRecord(ctx.order_id, productoId, varianteId, tnVar);
  const v = getVariantRef(productoId, varianteId).value();

  if (ctx.event === 'order/cancelled') {
    if (!rec || rec.state !== 'sold') {
      console.log(`[WEBHOOK] Orden ${ctx.order_id} línea ${tnVar}: cancelada pero ${rec ? 'ya devuelta' : 'nunca descontó'}, ignorando.`);
      return;
    }
    const back = toNum(rec.qty) || qty;
    setItemRecord(ctx.order_id, productoId, varianteId, tnVar, { state: 'returned', qty: back });
    const newStock = toNum(v.stock) + back;
    pushLog(productoId, varianteId, {
      action: 'return', order_id: ctx.order_id, order_number: ctx.order_number, tn_variant_id: tnVar,
      delta: +back, stock: newStock, client: ctx.cliente, email: ctx.email || undefined,
      reason: `Cancelación de orden #${ctx.order_id}`
    }, { stock: newStock });
    ctx.changed = true;
    await syncVariante(productoId, varianteId, null, { force: [tnVar] }).catch(e => console.error('[WEBHOOK] Sync:', e.message));
    console.log(`[WEBHOOK] ${prod.nombre}/${v.label}: stock devuelto por cancelación → ${newStock}`);
    return;
  }

  if (rec) {
    if (ctx.event === 'order/paid' && rec.state === 'sold' && !rec.paid) {
      setItemRecord(ctx.order_id, productoId, varianteId, tnVar, { paid: true });
      pushLog(productoId, varianteId, {
        action: 'payment_confirmed', order_id: ctx.order_id, order_number: ctx.order_number, tn_variant_id: tnVar,
        delta: 0, stock: toNum(v.stock), client: ctx.cliente, reason: `Pago confirmado — orden #${ctx.order_id}`
      });
      console.log(`[WEBHOOK] Pago confirmado para orden ${ctx.order_id} (stock ya descontado en order/created)`);
    } else if (ctx.source !== 'catchup') {
      console.log(`[WEBHOOK] Orden ${ctx.order_id} línea ${tnVar} ya procesada, ignorando duplicado.`);
    }
    return;
  }

  // Marcar ANTES de cualquier await: un evento duplicado concurrente ya la ve procesada
  setItemRecord(ctx.order_id, productoId, varianteId, tnVar, { state: 'sold', qty, paid: ctx.event === 'order/paid' });
  const consumed = consumeHolds(productoId, varianteId, tnVar, qty);
  const before = toNum(v.stock);
  const newStock = Math.max(0, before - qty);
  pushLog(productoId, varianteId, {
    action: 'sale', order_id: ctx.order_id, order_number: ctx.order_number, tn_variant_id: tnVar,
    reservation_id: consumed[0], delta: -qty, stock: newStock,
    client: ctx.cliente, email: ctx.email || undefined, item_name: item.name || undefined,
    reason: saleReason(ctx, item.name || tnVar) + (ctx.source === 'catchup' ? ' · recuperada en revisión de órdenes' : '')
  }, { stock: newStock });
  ctx.changed = true;
  if (before < qty) flagOversold(ctx, { productoId, varianteId, tnVar }, qty, before, item.name);
  await syncVariante(productoId, varianteId, null, { force: [tnVar] }).catch(e => console.error('[WEBHOOK] Sync:', e.message));
  console.log(`[WEBHOOK] ${prod.nombre}/${v.label}: ${before} → ${newStock} (evento ${ctx.event}${consumed.length ? ', reserva consumida' : ''})`);
}

// Venta / cancelación de un combo: descuenta en las dos variantes individuales de SC
async function processComboItem(ctx, item, tnVar, qty, match, vm) {
  if (ctx.event !== 'order/cancelled' && match.createdAt && ctx.createdAt && ctx.createdAt < Date.parse(match.createdAt)) return;
  const sides = [];
  for (const tnId of [vm.v1id, vm.v2id]) {
    const int = findInternalByTnVariant(tnId);
    if (!int) {
      console.warn(`[WEBHOOK] Match ${match.nombre}: variante ${tnId} no encontrada en SC. Saltando descuento.`);
      if (ctx.event !== 'order/cancelled') {
        addAlert({
          key: `unlinked_sale|${ctx.order_id}|${tnVar}|${tnId}`, type: 'unlinked_sale', severity: 'warning', once: true,
          title: `Combo vendido con un producto no gestionado: ${match.nombre}`,
          detail: `Orden #${ctx.order_number || ctx.order_id} · ${vm.label}: la variante ${tnId} no está vinculada en SC, su stock no se descontó.`,
          order_id: ctx.order_id, variant_id: String(tnId)
        });
      }
      continue;
    }
    const same = sides.find(s => s.productoId === int.productoId && s.varianteId === int.varianteId);
    if (same) same.qty += qty; else sides.push({ ...int, qty, tnVar });
  }
  if (sides.length === 0) return;
  const prefix = `[MATCH ${match.nombre}] `;

  if (ctx.event === 'order/cancelled') {
    for (const s of sides) {
      const rec = getItemRecord(ctx.order_id, s.productoId, s.varianteId, tnVar);
      if (!rec || rec.state !== 'sold') continue;
      const back = toNum(rec.qty) || s.qty;
      setItemRecord(ctx.order_id, s.productoId, s.varianteId, tnVar, { state: 'returned', qty: back });
      const v = getVariantRef(s.productoId, s.varianteId).value();
      const newStock = toNum(v.stock) + back;
      pushLog(s.productoId, s.varianteId, {
        action: 'return', order_id: ctx.order_id, order_number: ctx.order_number, tn_variant_id: tnVar,
        delta: +back, stock: newStock, client: ctx.cliente, match_name: match.nombre,
        reason: `${prefix}Cancelación de orden #${ctx.order_id}`
      }, { stock: newStock });
      ctx.changed = true;
      await syncVariante(s.productoId, s.varianteId, null, { force: [tnVar] }).catch(e => console.error('[WEBHOOK] Sync:', e.message));
    }
    return;
  }

  const recs = sides.map(s => getItemRecord(ctx.order_id, s.productoId, s.varianteId, tnVar));
  if (recs.some(Boolean)) {
    if (ctx.event === 'order/paid') console.log(`[WEBHOOK] Match orden ${ctx.order_id}: pago confirmado (stock ya descontado en order/created)`);
    else if (ctx.source !== 'catchup') console.log(`[WEBHOOK] Match orden ${ctx.order_id} línea ${tnVar} ya procesada, ignorando duplicado.`);
    return;
  }
  console.log(`[WEBHOOK] Match detectado: ${match.nombre} | variante: ${vm.label}`);
  for (const s of sides) setItemRecord(ctx.order_id, s.productoId, s.varianteId, tnVar, { state: 'sold', qty: s.qty, paid: ctx.event === 'order/paid' });
  for (const s of sides) {
    const consumed = consumeHolds(s.productoId, s.varianteId, tnVar, s.qty);
    const v = getVariantRef(s.productoId, s.varianteId).value();
    const before = toNum(v.stock);
    const newStock = Math.max(0, before - s.qty);
    pushLog(s.productoId, s.varianteId, {
      action: 'sale', order_id: ctx.order_id, order_number: ctx.order_number, tn_variant_id: tnVar,
      reservation_id: consumed[0], delta: -s.qty, stock: newStock,
      client: ctx.cliente, email: ctx.email || undefined, item_name: vm.label, match_name: match.nombre,
      reason: saleReason(ctx, vm.label, prefix) + (consumed.length ? ` · reserva consumida` : '')
    }, { stock: newStock });
    ctx.changed = true;
    if (before < s.qty) flagOversold(ctx, s, s.qty, before, `${match.nombre} (${vm.label})`);
    console.log(`[WEBHOOK] Match: ${s.prod.nombre}/${v.label}: ${before} → ${newStock}`);
  }
  for (const s of sides) {
    await syncVariante(s.productoId, s.varianteId, null, { force: [tnVar] }).catch(e => console.error('[WEBHOOK] Sync:', e.message));
  }
}

app.post('/webhook/privacy', (req, res) => res.sendStatus(200));


// ════════════════════════════════════════════════════════════════════════════
// Matchs
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/matchs', (req, res) => {
  const matchs = db.get('matchs').value();
  if (!req.query.lite || req.query.lite === '0') return res.json(matchs);
  res.json(matchs.map(m => {
    const combos = (m.variantMap || []).map(vm => ({ label: vm.label, tn_variant_id: vm.tn_variant_id, stock: comboStockLocal(m, vm), sync_error: vm.sync_error || null }));
    return {
      id: m.id, nombre: m.nombre, tn_match_product_id: m.tn_match_product_id,
      precio: m.precio || null, precio_promocional: m.precio_promocional || null, imagen_url: m.imagen_url || null,
      producto1: { tn_product_id: m.producto1?.tn_product_id, nombre: m.producto1?.nombre },
      producto2: { tn_product_id: m.producto2?.tn_product_id, nombre: m.producto2?.nombre },
      combos_total: combos.length,
      combos_con_stock: combos.filter(c => c.stock === null || c.stock > 0).length,
      combos, createdAt: m.createdAt || null
    };
  }));
});

app.post('/api/matchs', async (req, res) => {
  const { nombre, producto1, producto2 } = req.body;
  if (!nombre || !producto1?.tn_product_id || !producto2?.tn_product_id) {
    return res.status(400).json({ error: 'Faltan datos: nombre, producto1, producto2' });
  }
  try {
    // 1. Obtener variantes de ambos productos
    const [p1data, p2data] = await Promise.all([
      tnRequest('GET', `/products/${producto1.tn_product_id}?fields=id,name,variants`),
      tnRequest('GET', `/products/${producto2.tn_product_id}?fields=id,name,variants`)
    ]);

    const p1name = producto1.nombre || (typeof p1data.name === 'object' ? p1data.name.es : p1data.name) || 'Producto 1';
    const p2name = producto2.nombre || (typeof p2data.name === 'object' ? p2data.name.es : p2data.name) || 'Producto 2';

    // Incluir TODAS las variantes (incluso las que tienen stock 0)
    // Filtrarlas excluiría talles que pueden recuperar stock después por devoluciones o nueva producción
    const v1list = p1data.variants;
    const v2list = p2data.variants;

    if (v1list.length === 0 || v2list.length === 0) {
      return res.status(400).json({ error: 'Uno de los productos no tiene variantes' });
    }

    // 2. Generar todas las combinaciones de variantes
    // Detectar qué índices de atributos diferencian las variantes (ignorar los que son iguales en todas, ej: color único)
    function getDifferentiatingIndices(variants) {
      if (!variants[0]?.values?.length) return [];
      const numAttrs = variants[0].values.length;
      const indices = [];
      for (let i = 0; i < numAttrs; i++) {
        const uniqueValues = new Set(variants.map(v => {
          const val = v.values[i];
          return val?.es || val?.en || (val && Object.values(val)[0]) || '';
        }));
        if (uniqueValues.size > 1) indices.push(i);
      }
      return indices.length > 0 ? indices : [0]; // fallback: usar el primer atributo
    }

    const p1Indices = getDifferentiatingIndices(v1list);
    const p2Indices = getDifferentiatingIndices(v2list);

    function getLabel(v, indices) {
      if (!v.values || v.values.length === 0) return v.sku || String(v.id);
      const useIndices = indices || [0];
      return useIndices.map(i => {
        const val = v.values[i];
        return val?.es || val?.en || (val && Object.values(val)[0]) || '';
      }).filter(Boolean).join(' / ') || v.sku || String(v.id);
    }

    // 3. Crear producto contenedor en TN
    const attributes = [
      { en: `${p1name} - Talle`, es: `${p1name} - Talle`, pt: `${p1name} - Talle` },
      { en: `${p2name} - Talle`, es: `${p2name} - Talle`, pt: `${p2name} - Talle` }
    ];

    // Construir variantes combinadas
    // TN no permite valores repetidos entre variantes de la misma propiedad
    // Si los talles son iguales en ambos productos, prefijamos con inicial del producto
    const v1Labels = new Set(v1list.map(v => getLabel(v, p1Indices)));
    const v2Labels = new Set(v2list.map(v => getLabel(v, p2Indices)));
    const hasConflict = [...v1Labels].some(l => v2Labels.has(l));

    // Extraer el nombre entre comillas, ej: HOODIE "JACK" -> JACK
    function extractQuotedName(name) {
      const match = name.match(/"([^"]+)"/);
      return match ? match[1] : name.split(' ').slice(-1)[0]; // fallback: última palabra
    }
    const p1short = extractQuotedName(p1name);
    const p2short = extractQuotedName(p2name);

    function getLabel1(v) {
      const base = getLabel(v, p1Indices);
      return hasConflict ? `${base} (${p1short})` : base;
    }
    function getLabel2(v) {
      const base = getLabel(v, p2Indices);
      return hasConflict ? `${base} (${p2short})` : base;
    }

    const variantesBody = [];
    const variantMap = []; // para guardar el mapa v1id+v2id => variant

    for (const v1 of v1list) {
      for (const v2 of v2list) {
        const stock = Math.min(
          v1.stock === null ? 9999 : v1.stock,
          v2.stock === null ? 9999 : v2.stock
        );
        variantesBody.push({
          values: [getLabel1(v1), getLabel2(v2)],
          price: null,
          stock: stock === 9999 ? null : stock,
          weight: 1
        });
        variantMap.push({ v1id: String(v1.id), v2id: String(v2.id), label: `${getLabel(v1, p1Indices)} / ${getLabel(v2, p2Indices)}` });
      }
    }

    const productBody = {
      name: { es: nombre, en: nombre, pt: nombre },
      description: { es: '', en: '', pt: '' },
      tags: 'sc-match',
      attributes,
      variants: variantesBody,
      published: true,
      ...(req.body.precio ? { price: String(req.body.precio) } : {}),
      ...(req.body.precio_promocional ? { promotional_price: String(req.body.precio_promocional) } : {}),
    };

    const tnProduct = await tnRequest('POST', '/products', productBody);
    const tnMatchProductId = String(tnProduct.id);

    // 4. Guardar match en DB con el mapa de variantes
    const nuevo = {
      id: `match_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      nombre,
      tn_match_product_id: tnMatchProductId,
      precio: req.body.precio || null,
      precio_promocional: req.body.precio_promocional || null,
      imagen_url: req.body.imagen_url || null,
      producto1: { tn_product_id: String(producto1.tn_product_id), nombre: p1name, variantes: v1list.map(v => ({ id: String(v.id), label: getLabel(v, p1Indices), stock: v.stock })) },
      producto2: { tn_product_id: String(producto2.tn_product_id), nombre: p2name, variantes: v2list.map(v => ({ id: String(v.id), label: getLabel(v, p2Indices), stock: v.stock })) },
      // TN devuelve las variantes creadas; se emparejan por sus valores (y por índice si no coinciden)
      variantMap: variantMap.map((vm, i) => {
        const byValues = (tnProduct.variants || []).find(tv => {
          const vals = (tv.values || []).map(x => x && (x.es || Object.values(x)[0]));
          return vals[0] === variantesBody[i].values[0] && vals[1] === variantesBody[i].values[1];
        });
        return { ...vm, tn_variant_id: String((byValues || tnProduct.variants[i] || {}).id || '') };
      }),
      createdAt: new Date().toISOString()
    };
    
    // Aplicar imagen si fue provista
    if (req.body.imagen_url) {
      tnRequest('PUT', `/products/${tnMatchProductId}`, { images: [{ src: req.body.imagen_url }] }).catch(e => console.warn('[MATCH] Error subiendo imagen:', e.message));
    }
    db.get('matchs').push(nuevo).write();
    console.log(`[MATCH] Creado: ${nombre} | TN product: ${tnMatchProductId} | ${variantesBody.length} variantes`);
    // El stock inicial salió de TN; recalcularlo desde SC (reservas incluidas)
    syncMatchStock(nuevo.id).catch(e => console.warn('[MATCH] Sync inicial:', e.message));
    emitChange('matchs');
    res.json(nuevo);
  } catch (e) {
    console.error('[MATCH] Error creando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tn-product/:id/variants — proxy para obtener variantes con stock de un producto TN
app.get('/api/tn-product/:id/variants', async (req, res) => {
  try {
    const product = await tnRequest('GET', `/products/${req.params.id}?fields=id,name,variants`);
    const variants = (product.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || '',
      stock: v.stock ?? null,
      values: v.values || [],
    }));
    res.json({ id: product.id, name: product.name, variants });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matchs/:id', async (req, res) => {
  const match = db.get('matchs').find({ id: req.params.id }).value();
  if (!match) return res.status(404).json({ error: 'Match no encontrado' });
  const { nombre, precio, precio_promocional, imagen_url } = req.body;
  try {
    // Actualizar en TN
    const tnBody = {};
    if (nombre) tnBody.name = { es: nombre, en: nombre, pt: nombre };
    if (precio) tnBody.price = precio;
    if (precio_promocional) tnBody.promotional_price = precio_promocional;
    if (imagen_url) tnBody.images = [{ src: imagen_url }];
    if (Object.keys(tnBody).length > 0) {
      await tnRequest('PUT', `/products/${match.tn_match_product_id}`, tnBody);
    }
    // Actualizar en DB local
    const updates = {};
    if (nombre) updates.nombre = nombre;
    if (precio) updates.precio = precio;
    if (precio_promocional) updates.precio_promocional = precio_promocional;
    if (imagen_url) updates.imagen_url = imagen_url;
    db.get('matchs').find({ id: req.params.id }).assign(updates).write();
    const updated = db.get('matchs').find({ id: req.params.id }).value();
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/matchs/:id', async (req, res) => {
  const match = db.get('matchs').find({ id: req.params.id }).value();
  if (!match) return res.status(404).json({ error: 'Match no encontrado' });
  // Si no se pudo borrar en TN, el combo queda: si no, el contenedor seguiría vendiendo sin descontar
  if (match.tn_match_product_id) {
    try { await tnRequest('DELETE', `/products/${match.tn_match_product_id}`); }
    catch (e) {
      if (e.status !== 404) return res.status(502).json({ error: `No se pudo borrar el combo en Tiendanube: ${e.message}. No se borró nada.` });
    }
  }
  db.get('matchs').remove({ id: req.params.id }).write();
  emitChange('matchs');
  res.json({ ok: true });
});

// PUT /api/matchs/:id/sync-stock — recalcular stock del contenedor basado en productos individuales
// Recalcula y empuja el stock de todos los combos de un match (forzado)
async function syncMatchStock(matchId) {
  const match = db.get('matchs').find({ id: matchId }).value();
  if (!match) { const e = new Error('Match no encontrado'); e.status = 404; throw e; }
  const ctx = {};
  let updated = 0;
  const errors = [];
  for (const vm of (match.variantMap || [])) {
    if (!vm.tn_variant_id) continue;
    try {
      const value = await computeComboStock(match, vm, ctx);
      if (value === undefined) continue;
      await tnRequest('PUT', `/products/${match.tn_match_product_id}/variants/${vm.tn_variant_id}`, { stock: value });
      vm.tn_stock = value; delete vm.sync_error;
      updated++;
    } catch (e) { vm.sync_error = e.message; errors.push({ label: vm.label, error: e.message }); }
  }
  db.write();
  emitChange('matchs');
  return { ok: errors.length === 0, updated, errors };
}
app.put('/api/matchs/:id/sync-stock', async (req, res) => {
  try { res.json(await syncMatchStock(req.params.id)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/admin/matchs/resync-all — re-sincronizar TODOS los matchs de una vez
// Útil cuando se detecta desincronización entre productos individuales y sus contenedores
app.post('/api/admin/matchs/resync-all', async (req, res) => {
  try {
    const result = await resyncAllMatchs();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Helper: agregar variantes faltantes a TODOS los matchs ─────────────────
// Detecta combinaciones de variantes individuales que no están en cada contenedor
// y las crea en TN. Bug histórico: al crear un match se filtraban variantes con
// stock 0, y al agregar talles nuevos a un producto, los matchs viejos no los incluyen.
async function repairAllMatchVariants(onProgress) {
  const matchs = db.get('matchs').value();
  const results = [];
  const productCache = {};

  async function getProductFull(tn_product_id) {
    if (productCache[tn_product_id]) return productCache[tn_product_id];
    const data = await tnRequest('GET', `/products/${tn_product_id}?fields=id,name,variants`);
    productCache[tn_product_id] = data;
    return data;
  }

  function getDifferentiatingIndices(variants) {
    if (!variants[0]?.values?.length) return [];
    const numAttrs = variants[0].values.length;
    const indices = [];
    for (let i = 0; i < numAttrs; i++) {
      const uniqueValues = new Set(variants.map(v => {
        const val = v.values[i];
        return val?.es || val?.en || (val && Object.values(val)[0]) || '';
      }));
      if (uniqueValues.size > 1) indices.push(i);
    }
    return indices.length > 0 ? indices : [0];
  }
  function getLabel(v, indices) {
    if (!v.values || v.values.length === 0) return v.sku || String(v.id);
    const useIndices = indices || [0];
    return useIndices.map(i => {
      const val = v.values[i];
      return val?.es || val?.en || (val && Object.values(val)[0]) || '';
    }).filter(Boolean).join(' / ') || v.sku || String(v.id);
  }
  function extractQuotedName(name) {
    const match = name.match(/"([^"]+)"/);
    return match ? match[1] : name.split(' ').slice(-1)[0];
  }

  for (const [mi, match] of matchs.entries()) {
    if (onProgress) onProgress({ current: mi, total: matchs.length, message: match.nombre });
    if (!match.tn_match_product_id || !match.variantMap || !match.producto1?.tn_product_id || !match.producto2?.tn_product_id) {
      results.push({ id: match.id, nombre: match.nombre, skipped: true, reason: 'datos incompletos' });
      continue;
    }
    try {
      const p1full = await getProductFull(match.producto1.tn_product_id);
      await new Promise(r => setTimeout(r, 400));
      const p2full = await getProductFull(match.producto2.tn_product_id);
      await new Promise(r => setTimeout(r, 400));

      const v1list = p1full.variants || [];
      const v2list = p2full.variants || [];

      const p1name = match.producto1.nombre || (typeof p1full.name === 'object' ? p1full.name.es : p1full.name) || 'Producto 1';
      const p2name = match.producto2.nombre || (typeof p2full.name === 'object' ? p2full.name.es : p2full.name) || 'Producto 2';

      const p1Indices = getDifferentiatingIndices(v1list);
      const p2Indices = getDifferentiatingIndices(v2list);

      const v1Labels = new Set(v1list.map(v => getLabel(v, p1Indices)));
      const v2Labels = new Set(v2list.map(v => getLabel(v, p2Indices)));
      const hasConflict = [...v1Labels].some(l => v2Labels.has(l));
      const p1short = extractQuotedName(p1name);
      const p2short = extractQuotedName(p2name);
      const label1 = v => hasConflict ? `${getLabel(v, p1Indices)} (${p1short})` : getLabel(v, p1Indices);
      const label2 = v => hasConflict ? `${getLabel(v, p2Indices)} (${p2short})` : getLabel(v, p2Indices);

      const existingPairs = new Set(match.variantMap.map(vm => `${vm.v1id}|${vm.v2id}`));
      const missing = [];
      for (const v1 of v1list) {
        for (const v2 of v2list) {
          const key = `${v1.id}|${v2.id}`;
          if (!existingPairs.has(key)) missing.push({ v1, v2 });
        }
      }

      if (missing.length === 0) {
        results.push({ id: match.id, nombre: match.nombre, missing: 0, added: 0 });
        continue;
      }

      const added = [];
      const failed = [];
      const newVariantMap = [...match.variantMap];

      for (const { v1, v2 } of missing) {
        const stock = Math.min(
          v1.stock === null || v1.stock === undefined ? 9999 : toNum(v1.stock),
          v2.stock === null || v2.stock === undefined ? 9999 : toNum(v2.stock)
        );
        const variantBody = {
          values: [label1(v1), label2(v2)],
          price: null,
          stock: stock === 9999 ? null : stock,
          weight: 1
        };
        try {
          const created = await tnRequest('POST', `/products/${match.tn_match_product_id}/variants`, variantBody);
          newVariantMap.push({
            v1id: String(v1.id),
            v2id: String(v2.id),
            label: `${getLabel(v1, p1Indices)} / ${getLabel(v2, p2Indices)}`,
            tn_variant_id: String(created.id || '')
          });
          added.push({ label: `${label1(v1)} + ${label2(v2)}`, stock, tn_variant_id: created.id });
        } catch (e) {
          if (/too many requests/i.test(e.message)) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const created = await tnRequest('POST', `/products/${match.tn_match_product_id}/variants`, variantBody);
              newVariantMap.push({
                v1id: String(v1.id),
                v2id: String(v2.id),
                label: `${getLabel(v1, p1Indices)} / ${getLabel(v2, p2Indices)}`,
                tn_variant_id: String(created.id || '')
              });
              added.push({ label: `${label1(v1)} + ${label2(v2)}`, stock, tn_variant_id: created.id });
            } catch (e2) { failed.push({ label: `${label1(v1)} + ${label2(v2)}`, error: e2.message }); }
          } else {
            failed.push({ label: `${label1(v1)} + ${label2(v2)}`, error: e.message });
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }

      db.get('matchs').find({ id: match.id }).assign({ variantMap: newVariantMap }).write();

      results.push({
        id: match.id, nombre: match.nombre,
        missing: missing.length,
        added: added.length,
        failed: failed.length,
        added_detail: added,
        failed_detail: failed
      });
      if (added.length > 0 || failed.length > 0) {
        console.log(`[REPAIR-MATCHS] "${match.nombre}": ${added.length}/${missing.length} variantes agregadas, ${failed.length} fallaron`);
      }
    } catch (e) {
      results.push({ id: match.id, nombre: match.nombre, error: e.message });
      console.error(`[REPAIR-MATCHS] Error en "${match.nombre}":`, e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  if (onProgress) onProgress({ current: matchs.length, total: matchs.length, message: 'Listo' });
  const totalAdded = results.reduce((a, r) => a + (r.added || 0), 0);
  const totalFailed = results.reduce((a, r) => a + (r.failed || 0), 0);
  const totalMissing = results.reduce((a, r) => a + (r.missing || 0), 0);
  return { total_matchs: matchs.length, total_missing: totalMissing, total_added: totalAdded, total_failed: totalFailed, results };
}

// POST /api/admin/matchs/repair-variants — agrega variantes faltantes a los combos
// Bug histórico: al crear un match se filtraban variantes con stock 0, que después
// no se incluyen aunque recuperen stock. Este endpoint recorre cada match, detecta
// qué combinaciones faltan en el contenedor y las crea en TN.
app.post('/api/admin/matchs/repair-variants', async (req, res) => {
  try {
    const result = await repairAllMatchVariants();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Panel: salud, resumen, stock liviano, actividad, alertas, tareas y eventos
// ════════════════════════════════════════════════════════════════════════════

const PKG_VERSION = (() => { try { return require('./package.json').version; } catch (_) { return '0'; } })();
const STARTED_AT = Date.now();
const DEFAULT_LOGO = 'https://acdn-us.mitiendanube.com/stores/001/443/972/themes/common/logo-1516620265-1747438419-3be83f5e868d070c706e3e78edcc8ad01747438419-320-0.webp';

app.get('/api/health', (req, res) => {
  res.json({
    ok: true, auth_required: !!ADMIN_TOKEN,
    version: `${PKG_VERSION}${process.env.RAILWAY_GIT_COMMIT_SHA ? '+' + process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : ''}`,
    uptime_s: Math.round((Date.now() - STARTED_AT) / 1000)
  });
});

// Datos de la tienda (nombre y logo), cacheados 1 hora; nunca bloquea al panel
let storeCache = { at: 0, data: null, loading: null };
function getStoreInfo() {
  const cfg = db.get('config').value();
  const fallback = { id: cfg.store_id || '', name: 'Minch', logo_url: DEFAULT_LOGO };
  if (storeCache.data && Date.now() - storeCache.at < 3600e3) return storeCache.data;
  if (!storeCache.loading && cfg.access_token && cfg.store_id) {
    storeCache.loading = tnRequest('GET', '/store').then(s => {
      const name = typeof s.name === 'object' ? (s.name.es || Object.values(s.name)[0]) : s.name;
      const logo = s.logo ? (String(s.logo).startsWith('//') ? 'https:' + s.logo : String(s.logo)) : DEFAULT_LOGO;
      storeCache = { at: Date.now(), data: { id: String(s.id || cfg.store_id), name: name || 'Minch', logo_url: logo }, loading: null };
    }).catch(() => { storeCache = { at: Date.now() - 3000e3, data: storeCache.data || fallback, loading: null }; });
  }
  return storeCache.data || fallback;
}

// Hora argentina (UTC-3, sin horario de verano)
const AR_OFFSET_MS = -3 * 3600e3;
function startOfDayAR(ts = Date.now()) {
  const d = new Date(ts + AR_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - AR_OFFSET_MS;
}

function buildComboIndex() {
  const idx = new Map(); // tn variant id → Set(match ids)
  for (const m of db.get('matchs').value()) {
    for (const vm of m.variantMap || []) {
      for (const id of [vm.v1id, vm.v2id]) {
        const k = String(id);
        if (!idx.has(k)) idx.set(k, new Set());
        idx.get(k).add(m.id);
      }
    }
  }
  return idx;
}

function variantLite(p, v, comboIdx, since7d) {
  const alloc = allocation(p.id, v.id);
  const matchIds = new Set();
  for (const l of v.links || []) for (const id of comboIdx.get(String(l.variant_id)) || []) matchIds.add(id);
  const log = v.log || [];
  const lastMove = log.find(e => e.action !== 'sync');
  const lastSale = log.find(e => e.action === 'sale');
  let vendidas7d = 0;
  for (const e of log) {
    if (Date.parse(e.ts) < since7d) break;
    if (e.action === 'sale') vendidas7d += Math.abs(toNum(e.delta));
  }
  const syncError = (v.links || []).map(l => l.sync_error).find(Boolean) || null;
  return {
    id: v.id, label: v.label,
    stock: alloc.stock, reservado: alloc.reserved, disponible: alloc.free,
    links: (v.links || []).map(l => ({
      product_id: l.product_id, variant_id: l.variant_id, label: l.label,
      tn_stock: l.tn_stock === undefined ? null : l.tn_stock,
      sync_error: l.sync_error || null, missing_in_tn: !!l.missing_in_tn
    })),
    matchs: matchIds.size,
    last_movement_at: lastMove ? lastMove.ts : null,
    last_sale_at: lastSale ? lastSale.ts : null,
    vendidas_7d: vendidas7d,
    sync_error: syncError
  };
}

function productosLite() {
  const comboIdx = buildComboIndex();
  const since7d = Date.now() - 7 * 86400e3;
  return db.get('productos').value().map(p => {
    const variantes = (p.variantes || []).map(v => variantLite(p, v, comboIdx, since7d));
    return {
      id: p.id, nombre: p.nombre,
      unidades: variantes.reduce((a, v) => a + v.stock, 0),
      disponibles: variantes.reduce((a, v) => a + v.disponible, 0),
      sin_stock: variantes.filter(v => v.disponible === 0).length,
      variantes
    };
  });
}

app.get('/api/overview', (req, res) => {
  const prods = productosLite();
  const vars = prods.flatMap(p => p.variantes);
  const holds = activeHolds();
  const today = startOfDayAR();
  const since7d = Date.now() - 7 * 86400e3;
  const ordersToday = new Set();
  let unitsToday = 0, units7d = 0;
  for (const p of db.get('productos').value()) {
    for (const v of p.variantes || []) {
      for (const e of v.log || []) {
        const t = Date.parse(e.ts);
        if (t < since7d) break;
        if (e.action !== 'sale') continue;
        const u = Math.abs(toNum(e.delta));
        units7d += u;
        if (t >= today) { unitsToday += u; if (e.order_id) ordersToday.add(e.order_id); }
      }
    }
  }
  const cfg = db.get('config').value();
  const meta = db.get('meta').value() || {};
  res.json({
    store: getStoreInfo(),
    kpis: {
      productos: prods.length, variantes: vars.length,
      unidades: vars.reduce((a, v) => a + v.stock, 0),
      sin_stock: vars.filter(v => v.disponible === 0).length,
      stock_bajo: vars.filter(v => v.disponible > 0 && v.disponible <= 3).length,
      reservas_activas: holds.length,
      unidades_reservadas: holds.reduce((a, h) => a + toNum(h.qty), 0),
      ventas_hoy: ordersToday.size, unidades_vendidas_hoy: unitsToday, unidades_vendidas_7d: units7d
    },
    alerts_open: db.get('alerts').value().filter(a => !a.dismissed).length,
    health: {
      tn_configured: !!(cfg.access_token && cfg.store_id),
      webhooks_registered: !!cfg.webhook_registered,
      last_webhook_at: meta.last_webhook_at || null,
      last_reconcile_at: meta.last_reconcile_at || null,
      last_catchup_at: meta.last_catchup_at || null
    },
    jobs: [...jobs.values()].filter(j => j.status === 'running')
  });
});

app.get('/api/productos/:id/variantes/:varId/log', (req, res) => {
  const p = db.get('productos').find({ id: req.params.id }).value();
  const v = p && (p.variantes || []).find(x => x.id === req.params.varId);
  if (!v) return res.status(404).json({ error: 'Variante no encontrada' });
  const limit = Math.min(500, Math.max(1, toNum(req.query.limit) || 200));
  res.json((v.log || []).slice(0, limit).map((e, i) => activityItem(p, v, e, i)));
});

// ─── Actividad ───────────────────────────────────────────────────────────────
const ACTIONS = {
  sale: ['sale', 'Venta'], return: ['sale', 'Devolución'], payment_confirmed: ['sale', 'Pago OK'],
  cart_added: ['cart', 'Carrito'], cart_released: ['cart', 'Carrito liberado'], cart_expired: ['cart', 'Carrito vencido'],
  cart_rejected: ['cart', 'Carrito rechazado'],
  reserved: ['cart', 'Carrito'], reservation_released: ['cart', 'Carrito liberado'], reservation_expired: ['cart', 'Carrito vencido'],
  set: ['stock', 'Ajuste'], add: ['stock', 'Ajuste'], subtract: ['stock', 'Ajuste'], created: ['stock', 'Alta'],
  sanitized: ['stock', 'Saneo'], reconciled: ['stock', 'Reconciliación'],
  sync: ['sync', 'Sync'], oversold: ['error', 'Sobreventa']
};
// Formato viejo del reason: "[MATCH X] Cliente · mail — Producto (orden #123)"
const REASON_RE = /^(?:\[MATCH ([^\]]+)\] )?(.+?)(?: · (\S+@\S+))? — (.+?) \(orden #(\d+)\)/;

function activityItem(p, v, e, i) {
  let [category, title] = ACTIONS[e.action] || ['stock', e.action || 'Movimiento'];
  if (e.action === 'sync' && e.errors && e.errors.length) { category = 'error'; title = 'Error de sync'; }
  let client = e.client || null, email = e.email || null, detail = e.reason || '';
  if ((e.action === 'sale' || e.action === 'return') && e.reason) {
    const m = REASON_RE.exec(e.reason);
    if (m) {
      client = client || m[2]; email = email || m[3] || null;
      detail = (m[1] ? `Combo ${m[1]} · ` : '') + (e.item_name || m[4]);
    }
  }
  if (e.action === 'sync') {
    detail = e.errors && e.errors.length
      ? e.errors.map(x => `${x.label || x.variant_id}: ${x.error}`).join(' | ')
      : `${toNum(e.links_updated)} producto(s) de TN${e.combos_updated ? ` + ${e.combos_updated} combo(s)` : ''} actualizados`;
  }
  return {
    id: `${p.id}|${v.id}|${e.ts}|${i}`, ts: e.ts, action: e.action, category, title,
    delta: e.delta === undefined ? null : toNum(e.delta), stock: e.stock === undefined ? null : toNum(e.stock),
    productoId: p.id, producto: p.nombre, varianteId: v.id, variante: v.label,
    order_id: e.order_id || null, order_number: e.order_number || null, client, email, detail
  };
}

app.get('/api/activity', (req, res) => {
  const limit = Math.min(500, Math.max(1, toNum(req.query.limit) || 100));
  const before = req.query.before ? Date.parse(req.query.before) : Infinity;
  const category = req.query.category && req.query.category !== 'all' ? String(req.query.category) : null;
  const includeSync = req.query.include_sync === '1' || req.query.include_sync === 'true';
  const q = String(req.query.q || '').trim().toLowerCase();
  const all = [];
  for (const p of db.get('productos').value()) {
    for (const v of p.variantes || []) {
      (v.log || []).forEach((e, i) => {
        if (!(Date.parse(e.ts) < before)) return;
        const it = activityItem(p, v, e, i);
        if (it.category === 'sync' && !includeSync && category !== 'sync') return;
        if (category && it.category !== category) return;
        if (q && ![it.producto, it.variante, it.client, it.email, it.order_id, it.order_number, it.detail, it.title]
          .some(x => x && String(x).toLowerCase().includes(q))) return;
        all.push(it);
      });
    }
  }
  all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const items = all.slice(0, limit);
  res.json({ items, next_before: all.length > limit ? items[items.length - 1].ts : null });
});

// ─── Alertas ─────────────────────────────────────────────────────────────────
app.get('/api/alerts', (req, res) => {
  const includeDismissed = req.query.include_dismissed === '1' || req.query.include_dismissed === 'true';
  res.json(db.get('alerts').value().filter(a => includeDismissed || !a.dismissed));
});
app.post('/api/alerts/dismiss-all', (req, res) => {
  let n = 0;
  for (const a of db.get('alerts').value()) if (!a.dismissed) { a.dismissed = true; a.dismissed_at = new Date().toISOString(); n++; }
  db.write();
  emitChange('alerts');
  res.json({ ok: true, dismissed: n });
});
app.post('/api/alerts/:id/dismiss', (req, res) => {
  const a = db.get('alerts').value().find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Alerta no encontrada' });
  a.dismissed = true; a.dismissed_at = new Date().toISOString();
  db.write();
  emitChange('alerts');
  res.json({ ok: true });
});

// ─── Tareas largas con progreso ──────────────────────────────────────────────
const jobs = new Map();
let jobSeq = 0;
const JOB_TYPES = {
  'resync-matchs': { label: 'Actualizar stock de combos', run: p => resyncAllMatchs(p) },
  'repair-matchs': { label: 'Agregar talles faltantes a combos', run: p => repairAllMatchVariants(p) },
  'reconcile': { label: 'Revisar órdenes y stock contra Tiendanube', run: p => runReconcileCycle(p) },
  'sync-all': { label: 'Sincronizar todo el stock a Tiendanube', run: p => syncAllVariants(null, p) },
  'sync-product': { label: 'Sincronizar producto', run: (p, params) => syncAllVariants(params.productoId, p) }
};

async function syncAllVariants(productoId, onProgress) {
  const list = [];
  for (const p of db.get('productos').value()) {
    if (productoId && p.id !== productoId) continue;
    for (const v of p.variantes || []) list.push({ p, v });
  }
  if (productoId && list.length === 0 && !db.get('productos').find({ id: productoId }).value()) throw new Error('Producto no encontrado');
  const errors = [];
  let updated = 0;
  for (let i = 0; i < list.length; i++) {
    const { p, v } = list[i];
    if (onProgress) onProgress({ current: i, total: list.length, message: `${p.nombre} · ${v.label}` });
    try {
      const r = await syncVariante(p.id, v.id, null, { force: true });
      updated += r.updated + (r.combos_updated || 0);
      for (const e of r.errors) errors.push({ label: `${p.nombre} · ${v.label} · ${e.label}`, error: e.error });
    } catch (e) { errors.push({ label: `${p.nombre} · ${v.label}`, error: e.message }); }
  }
  if (onProgress) onProgress({ current: list.length, total: list.length, message: 'Listo' });
  return { variantes: list.length, actualizados: updated, errores: errors.length, errors: errors.slice(0, 100) };
}

function startJob(type, params = {}) {
  const def = JOB_TYPES[type];
  if (!def) { const e = new Error(`Tarea desconocida: ${type}`); e.status = 400; throw e; }
  for (const j of jobs.values()) {
    if (j.type === type && j.status === 'running' && JSON.stringify(j.params) === JSON.stringify(params)) return j;
  }
  let label = def.label;
  if (params.productoId) {
    const p = db.get('productos').find({ id: params.productoId }).value();
    label = `${def.label}: ${p ? p.nombre : params.productoId}`;
  }
  const job = {
    id: `job_${Date.now()}_${++jobSeq}`, type, label, params, status: 'running',
    progress: { current: 0, total: 0, message: 'Iniciando…' },
    started_at: new Date().toISOString(), finished_at: null, result: null, error: null, errors: []
  };
  jobs.set(job.id, job);
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  emitChange('jobs', { jobId: job.id });
  let lastEmit = 0;
  const onProgress = (p) => {
    job.progress = { ...job.progress, ...p };
    if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); emitChange('jobs', { jobId: job.id }); }
  };
  Promise.resolve()
    .then(() => def.run(onProgress, params))
    .then(result => {
      job.status = 'done';
      job.result = result;
      job.errors = (result && Array.isArray(result.errors)) ? result.errors
        : (result && Array.isArray(result.results)) ? result.results.filter(r => r.error).map(r => ({ label: r.nombre, error: r.error })) : [];
    })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error(`[JOB] ${type}:`, e.message); })
    .finally(() => {
      job.finished_at = new Date().toISOString();
      if (job.progress.total) job.progress.current = job.progress.total;
      emitChange('jobs', { jobId: job.id });
      emitChange('stock', {});
    });
  return job;
}

app.post('/api/jobs', (req, res) => {
  const { type, ...params } = req.body || {};
  try { res.json({ id: startJob(type, params).id }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/jobs', (req, res) => res.json([...jobs.values()].reverse().slice(0, 20)));
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Tarea no encontrada (puede que el servidor se haya reiniciado)' });
  res.json(j);
});

// ─── Eventos en vivo (SSE) ───────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': conectado\n\n');
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { /* cerrado */ } }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ─── Importar producto completo desde TN ─────────────────────────────────────
function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `PRODUCTO_${Date.now()}`;
}
function tnVariantLabel(tnV) {
  return (tnV.values || []).map(vv => vv && (vv.es || Object.values(vv)[0])).filter(Boolean).join(' / ') || tnV.sku || `Variante ${tnV.id}`;
}

app.post('/api/productos/import', async (req, res) => {
  const { tn_product_id } = req.body || {};
  if (!tn_product_id) return res.status(400).json({ error: 'Falta tn_product_id' });
  try {
    const tnProduct = await tnRequest('GET', `/products/${tn_product_id}?fields=id,name,variants`);
    const pName = typeof tnProduct.name === 'object' ? (tnProduct.name.es || Object.values(tnProduct.name)[0] || '') : String(tnProduct.name || '');
    const nombre = String(req.body.nombre || pName || `Producto ${tn_product_id}`).trim();
    const id = slugify(req.body.id || nombre);
    if (db.get('productos').find({ id }).value()) return res.status(409).json({ error: `Ya existe un producto con el código ${id}` });
    const now = new Date().toISOString();
    const variantes = [];
    const skipped = [];
    for (const tnV of tnProduct.variants || []) {
      const vLabel = tnVariantLabel(tnV);
      const already = findInternalByTnVariant(tnV.id);
      if (already) { skipped.push({ variant_id: String(tnV.id), label: vLabel, linked_to: `${already.prod.nombre} · ${already.variante.label}` }); continue; }
      const stock = Math.max(0, toNum(tnV.stock));
      variantes.push({
        id: `var_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, label: vLabel, stock,
        links: [{ product_id: String(tnProduct.id), variant_id: String(tnV.id), label: `${pName} · ${vLabel}`, linked_at: now, tn_stock: tnV.stock === null ? null : stock }],
        log: [{ ts: now, action: 'created', stock, reason: `Importada desde Tiendanube (${pName})` }]
      });
    }
    if (variantes.length === 0) return res.status(409).json({ error: 'Todas las variantes de ese producto ya están vinculadas a otro stock', skipped });
    const nuevo = { id, nombre, variantes };
    db.get('productos').push(nuevo).write();
    emitChange('stock', { productoId: id });
    console.log(`[IMPORT] ${nombre}: ${variantes.length} variantes (${skipped.length} ya vinculadas)`);
    res.json({ ...nuevo, skipped });
  } catch (e) { res.status(e.status === 404 ? 404 : 500).json({ error: e.status === 404 ? 'Ese producto no existe en Tiendanube' : e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Stats
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', (req, res) => {
  const productos = db.get('productos').value();
  const todasVariantes = productos.flatMap(p => p.variantes.map(v => ({ ...v, producto: p.nombre })));
  const now = Date.now();
  const activeReservations = db.get('reservations').filter(r => r.expiresAt > now).value();
  res.json({
    total_productos: productos.length,
    total_variantes: todasVariantes.length,
    total_links: todasVariantes.reduce((a, v) => a + v.links.length, 0),
    stock_bajo: todasVariantes.filter(v => v.stock <= 5 && v.stock > 0).length,
    sin_stock: todasVariantes.filter(v => v.stock === 0).length,
    active_reservations: activeReservations.length,
    recent_log: todasVariantes.flatMap(v => v.log.slice(0, 20).map(l => ({ ...l, producto: v.producto, variante: v.label })))
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 500)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════════════════════

// 404 y errores en JSON para la API (el panel muestra el mensaje)
app.use('/api', (req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`, code: 'not_found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 400 && err.type === 'entity.parse.failed' ? 'El cuerpo del pedido no es JSON válido' : err.message || 'Error interno', code: err.code || undefined });
});

migrateDb();

function startBackgroundJobs() {
  setInterval(() => releaseExpiredReservations().catch(e => console.error('[RESERVAS] Error:', e.message)), 60 * 1000);
  // Recuperar órdenes que no llegaron por webhook (deploys, caídas)
  setTimeout(() => catchUpOrders().catch(e => console.warn('[CATCHUP] Error:', e.message)), 30 * 1000);
  setInterval(() => catchUpOrders().catch(e => console.warn('[CATCHUP] Error:', e.message)), 10 * 60 * 1000);
  // Ciclo completo cada 6 horas (como tarea, para que el panel muestre el progreso).
  // Se mira la última corrida guardada: cada deploy reinicia los timers y si no nunca llegaría a correr.
  const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    const last = Date.parse(db.get('meta.last_reconcile_started_at').value() || 0) || 0;
    if (Date.now() - last < RECONCILE_EVERY_MS) return;
    setMeta('last_reconcile_started_at', new Date().toISOString());
    try { startJob('reconcile'); } catch (e) { console.error('[RECONCILIAR] Error:', e.message); }
  }, 10 * 60 * 1000);
}

process.on('unhandledRejection', (e) => console.error('[PROCESO] Promesa rechazada sin manejar:', e && e.message ? e.message : e));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Stock Central v2 + Reservas en puerto ${PORT}`);
    if (process.env.ACCESS_TOKEN && process.env.STORE_ID) {
      db.set('config.access_token', process.env.ACCESS_TOKEN).set('config.store_id', process.env.STORE_ID).write();
      console.log(`Credenciales cargadas: store ${process.env.STORE_ID}`);
    }
  });
  startBackgroundJobs();
}

module.exports = {
  app, db, processOrderEvent, toNum, tnRequest, syncVariante, syncMatchStock, releaseExpiredReservations,
  runReconcileCycle, resyncAllMatchs, repairAllMatchVariants, reconcileProducts, catchUpOrders,
  allocation, channelStock, getAvailableStock, startJob, migrateDb, addAlert
};
