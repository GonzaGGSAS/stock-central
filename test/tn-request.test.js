'use strict';
// h. tnRequest: reintentos ante 429 y errores
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

test('2 respuestas 429 seguidas y después OK → el request termina bien', { timeout: 20000 }, async () => {
  await sc.reset(remeraWorld());
  sc.tn.clearCalls();
  sc.tn.fail429(2, 50);
  const store = await sc.tnRequest('GET', '/store');
  assert.equal(store.name.es, 'Minch');
  const calls = sc.tn.callsTo('GET', '/store');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.status), [429, 429, 200]);
});

test('PUT de stock con 429 intermedio llega igual a TN', { timeout: 20000 }, async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  sc.tn.fail429(1, 10);
  await sc.tnRequest('PUT', '/products/100/variants/1001', { stock: 2 });
  assert.equal(sc.tn.getStock(1001), 2);
});

test('error no-429 se propaga con status y descripción de TN', async () => {
  await sc.reset(remeraWorld());
  await assert.rejects(sc.tnRequest('GET', '/products/123456'), e => e.status === 404 && /does not exist/.test(e.message));
});

test('manda store_id y header Authentication', async () => {
  await sc.reset(remeraWorld());
  sc.tn.clearCalls();
  await sc.tnRequest('GET', '/products/100');
  const [c] = sc.tn.calls;
  assert.equal(c.storeId, '1');
  assert.equal(c.auth, 'bearer test');
});

test('sin configuración → error "No configurado"', async () => {
  await sc.reset({ seed: { config: { access_token: '', store_id: '' } } });
  await assert.rejects(sc.tnRequest('GET', '/store'), /No configurado/);
});

test('GET /api/tn-products pagina hasta "Last page is N"', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: 1000 + i, name: `P${i}`, variants: [{ id: 50000 + i, values: ['U'], stock: 1 }] }));
  await sc.reset({ tnProducts: many });
  const r = await sc.api('GET', '/api/tn-products');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 51);
});
