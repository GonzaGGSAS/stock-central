'use strict';
/**
 * Helpers de test para Stock Central.
 *
 *   const sc = await startServer(world)   // una vez por archivo (server.js queda cacheado por require)
 *   await sc.reset(world)                 // estado limpio (DB + TN falso) entre tests
 *   await sc.api('POST', '/api/reserve', {...}) → { status, body }
 *   await sc.close()
 *
 * Un "world" es { seed: { productos, matchs, reservations, config? }, tnProducts: [...] }.
 * Los fixtures remeraWorld() y buzosWorld() arman mundos coherentes (SC + TN).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createFakeTN } = require('./fake-tn');

const VERBOSE = process.env.SC_TEST_VERBOSE === '1';

function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

// ─── Espera genérica ───────────────────────────────────────────────────────
/**
 * Reintenta `fn` hasta que devuelva algo truthy (o no tire). Si `fn` tira (p. ej. un
 * assert), al vencer el timeout se relanza el último error, así el mensaje es útil.
 */
async function waitFor(fn, timeout = 3000, interval = 25) {
  const start = Date.now();
  let lastErr = null, lastVal;
  for (;;) {
    try {
      lastVal = await fn();
      if (lastVal) return lastVal;
      lastErr = null;
    } catch (e) { lastErr = e; }
    if (Date.now() - start >= timeout) {
      if (lastErr) throw lastErr;
      throw new Error(`waitFor: timeout de ${timeout}ms (último valor: ${JSON.stringify(lastVal)})`);
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

// ─── Constructores de seed ─────────────────────────────────────────────────
const DEFAULT_CONFIG = { access_token: 'test', store_id: '1', webhook_registered: true };

function link(product_id, variant_id, label) {
  return { product_id: String(product_id), variant_id: String(variant_id), label: label || `P:${product_id} V:${variant_id}` };
}
function variante(id, label, stock, links = [], log = []) {
  return { id, label, stock, links, log };
}
function buildDb(seed = {}) {
  return {
    config: { ...DEFAULT_CONFIG, ...(seed.config || {}) },
    productos: clone(seed.productos || []),
    reservations: clone(seed.reservations || []),
    matchs: clone(seed.matchs || []),
    ...(clone(seed.extra) || {}),
  };
}

/** Une varios worlds en uno. */
function combine(...worlds) {
  const out = { seed: { productos: [], matchs: [], reservations: [] }, tnProducts: [] };
  for (const w of worlds) {
    out.seed.productos.push(...clone(w.seed?.productos || []));
    out.seed.matchs.push(...clone(w.seed?.matchs || []));
    out.seed.reservations.push(...clone(w.seed?.reservations || []));
    out.tnProducts.push(...clone(w.tnProducts || []));
  }
  return out;
}

/**
 * Remera con SKU compartido: el mismo stock SC vendido en dos productos de TN (dos diseños).
 *   TN 100 "REMERA A" : 1001 (S), 1002 (M)
 *   TN 200 "REMERA B" : 2001 (S), 2002 (M)
 *   SC REMERA         : var_s → [1001, 2001], var_m → [1002, 2002]
 * Por defecto TN arranca con el mismo stock que SC (tnS/tnM para forzar otra cosa).
 */
function remeraWorld({ s = 5, m = 5, tnS, tnM, reservations = [] } = {}) {
  const tS = tnS === undefined ? s : tnS;
  const tM = tnM === undefined ? m : tnM;
  return {
    seed: {
      productos: [{
        id: 'REMERA', nombre: 'Remera negra',
        variantes: [
          variante('var_s', 'S', s, [link(100, 1001, 'REMERA A · S'), link(200, 2001, 'REMERA B · S')]),
          variante('var_m', 'M', m, [link(100, 1002, 'REMERA A · M'), link(200, 2002, 'REMERA B · M')]),
        ],
      }],
      reservations,
    },
    tnProducts: [
      { id: 100, name: 'REMERA A', variants: [{ id: 1001, values: ['Negro', 'S'], stock: tS, sku: 'REM-S' }, { id: 1002, values: ['Negro', 'M'], stock: tM, sku: 'REM-M' }] },
      { id: 200, name: 'REMERA B', variants: [{ id: 2001, values: ['Negro', 'S'], stock: tS, sku: 'REM-S' }, { id: 2002, values: ['Negro', 'M'], stock: tM, sku: 'REM-M' }] },
    ],
  };
}

/**
 * Combo (Match) de dos buzos.
 *   TN 300 BUZO "CHANDLER": 3001 S, 3002 M     SC BUZO_CHANDLER: var_cs → 3001, var_cm → 3002
 *   TN 400 BUZO "MONICA"  : 4001 S, 4002 M     SC BUZO_MONICA  : var_ms → 4001, var_mm → 4002
 *   TN 900 contenedor     : 9001 S/S, 9002 S/M, 9003 M/S, 9004 M/M  (match_1)
 * El contenedor arranca con min() de los individuales, salvo que se pase `container`.
 */
function buzosWorld({ cs = 3, cm = 2, ms = 2, mm = 0, container, reservations = [] } = {}) {
  const pairs = [
    { tn: 9001, v1: 3001, v2: 4001, label: 'S / S', s: Math.min(cs, ms) },
    { tn: 9002, v1: 3001, v2: 4002, label: 'S / M', s: Math.min(cs, mm) },
    { tn: 9003, v1: 3002, v2: 4001, label: 'M / S', s: Math.min(cm, ms) },
    { tn: 9004, v1: 3002, v2: 4002, label: 'M / M', s: Math.min(cm, mm) },
  ];
  return {
    seed: {
      productos: [
        { id: 'BUZO_CHANDLER', nombre: 'Buzo Chandler', variantes: [
          variante('var_cs', 'S', cs, [link(300, 3001, 'BUZO "CHANDLER" · S')]),
          variante('var_cm', 'M', cm, [link(300, 3002, 'BUZO "CHANDLER" · M')]),
        ] },
        { id: 'BUZO_MONICA', nombre: 'Buzo Monica', variantes: [
          variante('var_ms', 'S', ms, [link(400, 4001, 'BUZO "MONICA" · S')]),
          variante('var_mm', 'M', mm, [link(400, 4002, 'BUZO "MONICA" · M')]),
        ] },
      ],
      matchs: [{
        id: 'match_1', nombre: 'BUZOS CHANDLER + MONICA', tn_match_product_id: '900',
        precio: '50000', precio_promocional: null, imagen_url: null,
        producto1: { tn_product_id: '300', nombre: 'BUZO "CHANDLER"' },
        producto2: { tn_product_id: '400', nombre: 'BUZO "MONICA"' },
        variantMap: pairs.map(p => ({ v1id: String(p.v1), v2id: String(p.v2), label: p.label, tn_variant_id: String(p.tn) })),
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      reservations,
    },
    tnProducts: [
      { id: 300, name: 'BUZO "CHANDLER"', variants: [{ id: 3001, values: ['S'], stock: cs }, { id: 3002, values: ['M'], stock: cm }] },
      { id: 400, name: 'BUZO "MONICA"', variants: [{ id: 4001, values: ['S'], stock: ms }, { id: 4002, values: ['M'], stock: mm }] },
      { id: 900, name: 'BUZOS CHANDLER + MONICA', tags: 'sc-match', variants: pairs.map(p => ({
        id: p.tn, values: p.label.split(' / ').map((x, i) => `${x} (${i ? 'MONICA' : 'CHANDLER'})`),
        stock: container === undefined ? p.s : container,
      })) },
    ],
  };
}

// ─── Arranque ──────────────────────────────────────────────────────────────
let started = false;

function silenceConsole() {
  if (VERBOSE) return;
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = () => {};
}

async function startServer(world = {}) {
  if (started) throw new Error('startServer() solo una vez por archivo de test (server.js queda cacheado)');
  started = true;

  const tn = createFakeTN();
  await tn.listen();
  for (const p of world.tnProducts || []) tn.addProduct(clone(p));

  const dbPath = path.join(os.tmpdir(), `stock-central-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(dbPath, JSON.stringify(buildDb(world.seed), null, 2));

  process.env.DB_PATH = dbPath;
  process.env.TN_API_BASE = tn.url;
  process.env.TN_THROTTLE = 'off';
  process.env.SC_RESERVE_RATE_PER_MIN = '100000'; // todos los tests reservan desde 127.0.0.1
  delete process.env.ADMIN_TOKEN;
  delete process.env.ACCESS_TOKEN;
  delete process.env.STORE_ID;

  silenceConsole();
  const sc = require('../server.js');
  const server = sc.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { db } = sc;

  async function api(method, p, body) {
    const res = await fetch(baseUrl + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* queda como texto */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const ctx = {
    ...sc, sc, db, server, baseUrl, tn, api, dbPath,

    /** Estado limpio: espera a que terminen syncs en background, y recarga DB + TN. */
    async reset(w = {}, { quietMs = 350 } = {}) {
      await tn.idle(quietMs);
      tn.reset();
      for (const p of w.tnProducts || []) tn.addProduct(clone(p));
      const cur = db.getState();
      const next = {};
      // Colecciones nuevas que agregue el server (alerts, jobs, …) se vacían; objetos se conservan.
      for (const [k, v] of Object.entries(cur)) next[k] = Array.isArray(v) ? [] : v;
      Object.assign(next, buildDb(w.seed));
      db.setState(next).write();
    },

    variante(productoId, varId) {
      return clone(db.get('productos').find({ id: productoId }).get('variantes').find({ id: varId }).value());
    },
    stock(productoId, varId) { return ctx.variante(productoId, varId)?.stock; },
    log(productoId, varId) { return ctx.variante(productoId, varId)?.log || []; },
    reservations() { return clone(db.get('reservations').value()); },
    match(id) { return clone(db.get('matchs').find({ id }).value()); },

    /** Crea la orden en el TN falso y devuelve su id. */
    order(products, extra = {}) { return tn.addOrder({ products, ...extra }); },
    /** processOrderEvent esperado (el server hace GET /orders/:id al TN falso). */
    process(event, orderId) {
      // TN marca la orden como cancelada antes de mandar order/cancelled
      if (event === 'order/cancelled' && tn.getOrder && tn.getOrder(orderId)) tn.setOrder(orderId, { status: 'cancelled' });
      return sc.processOrderEvent(event, orderId);
    },

    reserve(sessionId, variant_id, qty = 1) {
      return api('POST', '/api/reserve', { sessionId, variant_id: String(variant_id), qty });
    },
    release(sessionId, variant_id) {
      return api('DELETE', `/api/reserve/${encodeURIComponent(sessionId)}${variant_id ? `?variant_id=${variant_id}` : ''}`);
    },

    /** GET /api/alerts con assert de que el endpoint existe. */
    async alerts(query = '') {
      const r = await api('GET', `/api/alerts${query}`);
      if (r.status !== 200 || !Array.isArray(r.body)) {
        throw new Error(`GET /api/alerts${query} → ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 80) : JSON.stringify(r.body)}`);
      }
      return r.body;
    },

    async close() {
      await tn.idle(200, 5000);
      server.closeAllConnections?.();
      await new Promise(r => server.close(() => r()));
      await tn.close();
      try { fs.unlinkSync(dbPath); } catch (_) {}
    },
  };
  return ctx;
}

module.exports = { startServer, waitFor, link, variante, buildDb, combine, remeraWorld, buzosWorld, clone };
