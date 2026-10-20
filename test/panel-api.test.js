'use strict';
/**
 * k. Endpoints del panel según docs/api-panel.md
 * Mundo: REMERA (var_s 3 con 1 reservada, var_m 0) + buzos (CS 3, CM 2, MS 2, MM 0) + combo.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld, buzosWorld, combine } = require('./helpers');

const world = () => {
  const w = combine(
    remeraWorld({
      s: 3, m: 0,
      reservations: [
        { id: 'res_k1', sessionId: 'sess-k', productoId: 'REMERA', varianteId: 'var_s', tnVariantId: '1001', qty: 1, expiresAt: Date.now() + 20 * 60 * 1000 },
        { id: 'res_old', sessionId: 'sess-old', productoId: 'REMERA', varianteId: 'var_s', tnVariantId: '1001', qty: 5, expiresAt: Date.now() - 60 * 1000 },
      ],
    }),
    buzosWorld(),
    { tnProducts: [{ id: 700, name: 'GORRA SUELTA', variants: [{ id: 7777, values: ['Única'], stock: 4 }] }] },
  );
  return w;
};
const QUIET = { quietMs: 900 };

let sc;
before(async () => { sc = await startServer(world()); });
after(async () => { await sc.close(); });

function assertErrorShape(r) {
  assert.ok(r.body && typeof r.body === 'object', `respuesta de error no es JSON: ${String(r.body).slice(0, 80)}`);
  assert.equal(typeof r.body.error, 'string');
}

test('[nuevo] GET /api/health', async () => {
  const r = await sc.api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.auth_required, false);
  assert.equal(typeof r.body.version, 'string');
  assert.equal(typeof r.body.uptime_s, 'number');
});

test('[nuevo] GET /api/overview', { timeout: 20000 }, async () => {
  await sc.reset(world(), QUIET);
  // una venta hoy: 2 unidades de CHANDLER S (3 → 1)
  const oid = sc.order([{ variant_id: 3001, quantity: 2 }]);
  await sc.process('order/created', oid);
  await sc.tn.idle(900);

  const r = await sc.api('GET', '/api/overview');
  assert.equal(r.status, 200, `status ${r.status}`);
  const o = r.body;
  assert.equal(String(o.store.id), '1');
  assert.equal(o.store.name, 'Minch');
  assert.equal(typeof o.store.logo_url, 'string');

  // disponibles: var_s 3−1=2, var_m 0, CS 1, CM 2, MS 2, MM 0
  assert.deepEqual(o.kpis, {
    ...o.kpis,
    productos: 3, variantes: 6, unidades: 3 + 0 + 1 + 2 + 2 + 0,
    sin_stock: 2, stock_bajo: 4,
    reservas_activas: 1, unidades_reservadas: 1,
    ventas_hoy: 1, unidades_vendidas_hoy: 2, unidades_vendidas_7d: 2,
  });
  assert.equal(typeof o.alerts_open, 'number');
  assert.equal(o.health.tn_configured, true);
  assert.equal(o.health.webhooks_registered, true);
  assert.ok('last_webhook_at' in o.health);
  assert.ok('last_reconcile_at' in o.health);
  assert.ok(Array.isArray(o.jobs));
});

test('[nuevo] GET /api/productos?lite=1: stock / reservado / disponible', async () => {
  await sc.reset(world(), QUIET);
  const r = await sc.api('GET', '/api/productos?lite=1');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  const rem = r.body.find(p => p.id === 'REMERA');
  assert.ok(rem);
  assert.equal(rem.nombre, 'Remera negra');
  assert.equal(rem.unidades, 3);
  assert.equal(rem.disponibles, 2);
  assert.equal(rem.sin_stock, 1);

  const vs = rem.variantes.find(v => v.id === 'var_s');
  assert.equal(vs.label, 'S');
  assert.equal(vs.stock, 3);
  assert.equal(vs.reservado, 1, 'la reserva expirada no cuenta');
  assert.equal(vs.disponible, 2);
  assert.equal(vs.links.length, 2);
  for (const l of vs.links) {
    assert.equal(typeof l.product_id, 'string');
    assert.equal(typeof l.variant_id, 'string');
    assert.equal(typeof l.label, 'string');
    assert.ok('tn_stock' in l);
  }
  assert.equal(vs.matchs, 0);
  assert.ok('sync_error' in vs);
  assert.equal(typeof vs.vendidas_7d, 'number');
  assert.equal(vs.log, undefined, 'lite no debería mandar los logs completos');

  const cs = r.body.find(p => p.id === 'BUZO_CHANDLER').variantes.find(v => v.id === 'var_cs');
  assert.ok(cs.matchs >= 1, 'var_cs está en un combo');
});

test('GET /api/productos (sin lite) mantiene el formato viejo con logs', async () => {
  await sc.reset(world(), QUIET);
  const r = await sc.api('GET', '/api/productos');
  assert.equal(r.status, 200);
  const rem = r.body.find(p => p.id === 'REMERA');
  assert.ok(Array.isArray(rem.variantes[0].log));
  assert.ok(Array.isArray(rem.variantes[0].links));
});

test('[nuevo] GET /api/activity', { timeout: 20000 }, async () => {
  await sc.reset(world(), QUIET);
  const oid = sc.order([{ variant_id: 3001, quantity: 2, name: 'BUZO "CHANDLER" (S)' }], { contact_name: 'Florencia P.', contact_email: 'flor@test.com' });
  await sc.process('order/created', oid);
  await sc.tn.idle(900);

  const r = await sc.api('GET', '/api/activity?limit=50');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.ok('next_before' in r.body);
  const it = r.body.items.find(i => i.action === 'sale' && String(i.order_id) === String(oid));
  assert.ok(it, 'falta la venta en la actividad');
  assert.equal(typeof it.id, 'string');
  assert.equal(it.category, 'sale');
  assert.equal(typeof it.title, 'string');
  assert.equal(it.delta, -2);
  assert.equal(it.stock, 1);
  assert.equal(it.productoId, 'BUZO_CHANDLER');
  assert.equal(it.producto, 'Buzo Chandler');
  assert.equal(it.varianteId, 'var_cs');
  assert.equal(it.variante, 'S');
  assert.equal(it.client, 'Florencia P.');
  assert.equal(it.email, 'flor@test.com');
  // por defecto no incluye syncs
  assert.ok(!r.body.items.some(i => i.action === 'sync'), 'include_sync=0 por defecto');

  const onlySales = await sc.api('GET', '/api/activity?category=sale');
  assert.equal(onlySales.status, 200);
  assert.ok(onlySales.body.items.length >= 1);
  assert.ok(onlySales.body.items.every(i => i.category === 'sale'));

  const q = await sc.api('GET', `/api/activity?q=${encodeURIComponent('Florencia')}`);
  assert.ok(q.body.items.some(i => String(i.order_id) === String(oid)));

  const lim = await sc.api('GET', '/api/activity?limit=1&include_sync=1');
  assert.equal(lim.body.items.length, 1);
});

test('[nuevo] GET /api/alerts + dismiss + dismiss-all', async () => {
  await sc.reset(world(), QUIET);
  const o1 = sc.order([{ variant_id: 7777, quantity: 1 }]);
  const o2 = sc.order([{ variant_id: 7777, quantity: 1 }]);
  await sc.process('order/created', o1);
  await sc.process('order/created', o2);

  let alerts = await sc.alerts();
  assert.ok(alerts.length >= 1, 'debería haber alertas unlinked_sale');
  const a = alerts.find(x => x.type === 'unlinked_sale');
  assert.ok(a);
  for (const k of ['id', 'ts', 'type', 'severity', 'title', 'count', 'dismissed']) assert.ok(k in a, `alerta sin campo ${k}`);

  const ov = await sc.api('GET', '/api/overview');
  assert.equal(ov.body.alerts_open, alerts.length);

  const d = await sc.api('POST', `/api/alerts/${encodeURIComponent(a.id)}/dismiss`);
  assert.equal(d.status, 200);
  alerts = await sc.alerts();
  assert.ok(!alerts.some(x => x.id === a.id), 'la alerta descartada no debería aparecer');
  const all = await sc.alerts('?include_dismissed=1');
  const again = all.find(x => x.id === a.id);
  assert.ok(again);
  assert.equal(again.dismissed, true);

  const da = await sc.api('POST', '/api/alerts/dismiss-all');
  assert.equal(da.status, 200);
  assert.deepEqual(await sc.alerts(), []);
});

test('[nuevo] POST /api/jobs resync-matchs → status done', { timeout: 30000 }, async () => {
  await sc.reset(combine(buzosWorld({ container: 99 })), QUIET);
  const r = await sc.api('POST', '/api/jobs', { type: 'resync-matchs' });
  assert.equal(r.status, 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(typeof r.body.id, 'string');
  const id = r.body.id;

  const job = await waitFor(async () => {
    const j = await sc.api('GET', `/api/jobs/${encodeURIComponent(id)}`);
    assert.equal(j.status, 200);
    assert.notEqual(j.body.status, 'error', `job con error: ${j.body.error}`);
    return j.body.status === 'done' ? j.body : null;
  }, 20000, 100);

  assert.equal(job.id, id);
  assert.equal(job.type, 'resync-matchs');
  assert.equal(typeof job.label, 'string');
  assert.ok(job.progress && typeof job.progress === 'object');
  assert.ok(job.started_at);
  assert.ok(job.finished_at);
  assert.equal(job.error, null);
  assert.ok(Array.isArray(job.errors));
  assert.equal(sc.tn.getStock(9001), 2, 'el job debería haber recalculado el contenedor');

  const list = await sc.api('GET', '/api/jobs');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.some(j => j.id === id));
});

test('[nuevo] POST /api/jobs con tipo inválido → 400 { error }', async () => {
  const r = await sc.api('POST', '/api/jobs', { type: 'no-existe' });
  assert.equal(r.status, 400);
  assertErrorShape(r);
});

test('[nuevo] GET /api/jobs/:id inexistente → 404 { error }', async () => {
  const r = await sc.api('GET', '/api/jobs/job_no_existe');
  assert.equal(r.status, 404);
  assertErrorShape(r);
});

test('GET /api/config', async () => {
  await sc.reset(world(), QUIET);
  const r = await sc.api('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { store_id: '1', has_token: true, webhook_registered: true });
});

test('[nuevo] GET / sirve el panel (requiere public/panel/index.html)', async () => {
  const res = await fetch(sc.baseUrl + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
});
