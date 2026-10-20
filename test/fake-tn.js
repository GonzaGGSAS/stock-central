'use strict';
/**
 * Tiendanube falso en memoria para los tests de Stock Central.
 *
 * Imita las rutas de la API de TN que usa server.js, bajo `/:store_id`:
 *   GET/POST /products · GET/PUT/DELETE /products/:id
 *   GET/POST /products/:pid/variants · GET/PUT/DELETE /products/:pid/variants/:vid
 *   GET /orders · GET /orders/:id · GET /store · GET/POST/DELETE /webhooks
 *
 * Todo lo que llega queda en `calls[]` ({ method, path, query, body, status }).
 * `fail429(n, resetMs)` hace que los próximos n requests respondan 429.
 * Stock `null` = infinito (como en TN).
 */
const http = require('node:http');

function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function normValues(values) {
  return (values || []).map(v => (typeof v === 'string' ? { es: v } : v));
}
function normName(name) { return typeof name === 'string' ? { es: name } : (name || { es: '' }); }

function createFakeTN() {
  let server = null;
  const st = {
    store: { id: 1, name: { es: 'Minch' }, logo: 'https://cdn.example/minch.png' },
    products: new Map(),   // id(number) -> product
    orders: new Map(),     // id(number) -> order
    webhooks: [],
  };
  const counters = { product: 90000, variant: 900000, order: 7000, webhook: 1 };
  const calls = [];
  let pending429 = 0, reset429Ms = 0;
  let inflight = 0, lastActivity = Date.now();

  // ─── Estado ──────────────────────────────────────────────────────────────
  function findVariant(vid) {
    for (const p of st.products.values()) {
      const v = p.variants.find(x => String(x.id) === String(vid));
      if (v) return { product: p, variant: v };
    }
    return null;
  }
  function serializeProduct(p) {
    const out = clone(p);
    out.variants = out.variants.map(v => ({ ...v, product_id: p.id }));
    return out;
  }
  function serializeVariant(p, v) { return { ...clone(v), product_id: p.id }; }

  function addProduct({ id, name, variants = [], ...rest }) {
    const pid = id != null ? Number(id) : ++counters.product;
    const p = {
      id: pid, name: normName(name), attributes: rest.attributes || [], ...rest,
      variants: variants.map(v => ({
        id: v.id != null ? Number(v.id) : ++counters.variant,
        values: normValues(v.values),
        stock: v.stock === undefined ? 0 : v.stock,
        sku: v.sku || null,
        price: v.price ?? null,
      })),
    };
    st.products.set(pid, p);
    return serializeProduct(p);
  }

  function addOrder({ id, products = [], contact_name = 'Cliente Test', contact_email = 'cliente@test.com', status = 'open', created_at, ...rest } = {}) {
    const oid = id != null ? Number(id) : ++counters.order;
    const order = {
      id: oid, contact_name, contact_email, status,
      created_at: created_at || new Date().toISOString(),
      products: products.map(it => {
        const found = findVariant(it.variant_id);
        return {
          variant_id: Number(it.variant_id),
          product_id: it.product_id != null ? Number(it.product_id) : (found ? found.product.id : null),
          quantity: it.quantity ?? 1,
          name: it.name || `Producto ${it.variant_id}`,
        };
      }),
      ...rest,
    };
    st.orders.set(oid, order);
    return oid;
  }

  function setStock(vid, stock) {
    const f = findVariant(vid);
    if (!f) throw new Error(`fake-tn: variante ${vid} no existe`);
    f.variant.stock = stock;
  }
  function getStock(vid) {
    const f = findVariant(vid);
    if (!f) throw new Error(`fake-tn: variante ${vid} no existe`);
    return f.variant.stock;
  }
  function getVariant(vid) { const f = findVariant(vid); return f ? serializeVariant(f.product, f.variant) : null; }
  function getProduct(pid) { const p = st.products.get(Number(pid)); return p ? serializeProduct(p) : null; }

  function reset() {
    st.products.clear(); st.orders.clear(); st.webhooks.length = 0;
    calls.length = 0; pending429 = 0; reset429Ms = 0;
  }

  // ─── Rutas ───────────────────────────────────────────────────────────────
  const NF = (what = 'Not Found') => ({ status: 404, body: { code: 404, message: 'Not Found', description: what } });
  const OK = body => ({ status: 200, body });

  function route(method, parts, q, body) {
    const [res, a, sub, b] = parts;

    if (res === 'store' && parts.length === 1 && method === 'GET') return OK(clone(st.store));

    if (res === 'products') {
      if (parts.length === 1) {
        if (method === 'GET') {
          const per = Math.max(1, Math.min(200, Number(q.get('per_page')) || 30));
          const page = Math.max(1, Number(q.get('page')) || 1);
          const all = [...st.products.values()].sort((x, y) => x.id - y.id);
          if (all.length === 0) return OK([]);
          const last = Math.ceil(all.length / per);
          if (page > last) return { status: 404, body: { code: 404, message: 'Not Found', description: `Last page is ${last}` } };
          return OK(all.slice((page - 1) * per, page * per).map(serializeProduct));
        }
        if (method === 'POST') {
          const { variants = [], ...rest } = body || {};
          return { status: 201, body: addProduct({ ...rest, variants }) };
        }
      }
      const p = st.products.get(Number(a));
      if (parts.length === 2) {
        if (!p) return NF('Product with such id does not exist');
        if (method === 'GET') return OK(serializeProduct(p)); // `fields` se ignora
        if (method === 'PUT') {
          const { id: _i, variants: _v, ...rest } = body || {};
          Object.assign(p, rest);
          if (rest.name) p.name = normName(rest.name);
          return OK(serializeProduct(p));
        }
        if (method === 'DELETE') { st.products.delete(p.id); return OK({}); }
      }
      if (sub === 'variants') {
        if (!p) return NF('Product with such id does not exist');
        if (parts.length === 3) {
          if (method === 'GET') return OK(p.variants.map(v => serializeVariant(p, v)));
          if (method === 'POST') {
            const v = {
              id: ++counters.variant, values: normValues(body?.values),
              stock: body?.stock === undefined ? 0 : body.stock, sku: body?.sku || null, price: body?.price ?? null,
            };
            p.variants.push(v);
            return { status: 201, body: serializeVariant(p, v) };
          }
        }
        if (parts.length === 4) {
          const v = p.variants.find(x => String(x.id) === String(b));
          if (!v) return NF('Variant with such id does not exist');
          if (method === 'GET') return OK(serializeVariant(p, v));
          if (method === 'PUT') {
            const { id: _i, product_id: _p, ...rest } = body || {};
            if (rest.values) rest.values = normValues(rest.values);
            Object.assign(v, rest);
            return OK(serializeVariant(p, v));
          }
          if (method === 'DELETE') { p.variants = p.variants.filter(x => x !== v); return OK({}); }
        }
      }
    }

    if (res === 'orders') {
      if (parts.length === 1 && method === 'GET') {
        let list = [...st.orders.values()].sort((x, y) => x.id - y.id);
        const min = q.get('created_at_min');
        if (min) list = list.filter(o => new Date(o.created_at) >= new Date(min));
        const max = q.get('created_at_max');
        if (max) list = list.filter(o => new Date(o.created_at) <= new Date(max));
        if (q.get('status')) list = list.filter(o => o.status === q.get('status'));
        const per = Math.max(1, Math.min(200, Number(q.get('per_page')) || 30));
        const page = Math.max(1, Number(q.get('page')) || 1);
        if (list.length > 0) {
          const last = Math.ceil(list.length / per);
          if (page > last) return { status: 404, body: { code: 404, message: 'Not Found', description: `Last page is ${last}` } };
        }
        return OK(clone(list.slice((page - 1) * per, page * per)));
      }
      if (parts.length === 2 && method === 'GET') {
        const o = st.orders.get(Number(a));
        return o ? OK(clone(o)) : NF('Order with such id does not exist');
      }
    }

    if (res === 'webhooks') {
      if (parts.length === 1 && method === 'GET') return OK(clone(st.webhooks));
      if (parts.length === 1 && method === 'POST') {
        const w = { id: counters.webhook++, event: body?.event, url: body?.url, created_at: new Date().toISOString() };
        st.webhooks.push(w);
        return { status: 201, body: clone(w) };
      }
      if (parts.length === 2) {
        const w = st.webhooks.find(x => String(x.id) === String(a));
        if (!w) return NF();
        if (method === 'GET') return OK(clone(w));
        if (method === 'DELETE') { st.webhooks = st.webhooks.filter(x => x !== w); return OK({}); }
      }
    }

    return NF(`fake-tn: ruta no implementada ${method} /${parts.join('/')}`);
  }

  async function handle(req, res) {
    inflight++; lastActivity = Date.now();
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch (_) { body = raw; } }
      const url = new URL(req.url, 'http://fake-tn');
      const segs = url.pathname.split('/').filter(Boolean);
      const storeId = segs.shift();
      const call = {
        method: req.method, path: '/' + segs.join('/'), query: Object.fromEntries(url.searchParams),
        body, storeId, auth: req.headers['authentication'] || null, ts: Date.now(), status: null,
      };
      calls.push(call);

      let out;
      const headers = { 'Content-Type': 'application/json' };
      if (!call.auth) out = { status: 401, body: { code: 401, message: 'Unauthorized', description: 'Falta header Authentication' } };
      else if (pending429 > 0) {
        pending429--;
        headers['x-rate-limit-reset'] = String(reset429Ms);
        out = { status: 429, body: { code: 429, message: 'Too Many Requests', description: 'Too Many Requests' } };
      } else {
        try { out = route(req.method, segs, url.searchParams, body); }
        catch (e) { out = { status: 500, body: { description: `fake-tn error: ${e.message}` } }; }
      }
      call.status = out.status;
      res.writeHead(out.status, headers);
      res.end(JSON.stringify(out.body));
    } finally {
      inflight--; lastActivity = Date.now();
    }
  }

  // ─── API pública ─────────────────────────────────────────────────────────
  const tn = {
    url: null,
    state: st,
    calls,
    async listen() {
      server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch (_) {} }); });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      tn.url = `http://127.0.0.1:${server.address().port}`;
      return tn.url;
    },
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise(r => server.close(() => r()));
      server = null;
    },
    reset,
    addProduct, addOrder, setStock, getStock, getVariant, getProduct,
    setStore(s) { Object.assign(st.store, s); },
    getOrder(id) { return clone(st.orders.get(Number(id))); },
    setOrder(id, patch) { Object.assign(st.orders.get(Number(id)), patch); },
    /** Los próximos `n` requests responden 429 con header x-rate-limit-reset = resetMs. */
    fail429(n, resetMs = 0) { pending429 = n; reset429Ms = resetMs; },
    clearCalls() { calls.length = 0; },
    /** Llamadas filtradas por método y path (string exacto o RegExp). */
    callsTo(method, pathMatch) {
      return calls.filter(c => (!method || c.method === method) &&
        (pathMatch instanceof RegExp ? pathMatch.test(c.path) : c.path === pathMatch));
    },
    /** Bodies de los PUT a /products/:pid/variants/:vid para esa variante. */
    putsToVariant(vid) {
      return calls.filter(c => c.method === 'PUT' && new RegExp(`^/products/\\d+/variants/${vid}$`).test(c.path)).map(c => c.body);
    },
    /** Espera a que no haya requests en vuelo ni actividad durante `quietMs`. */
    async idle(quietMs = 350, timeoutMs = 15000) {
      const start = Date.now();
      for (;;) {
        if (inflight === 0 && Date.now() - lastActivity >= quietMs) return;
        if (Date.now() - start > timeoutMs) return;
        await new Promise(r => setTimeout(r, 25));
      }
    },
  };
  return tn;
}

module.exports = { createFakeTN };
