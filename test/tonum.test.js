'use strict';
// g. toNum y stocks guardados como string (bug histórico "4" + 1 = "41")
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

test('toNum', () => {
  assert.equal(sc.toNum('4'), 4);
  assert.equal(sc.toNum(4), 4);
  assert.equal(sc.toNum(' 7 '), 7);
  assert.equal(sc.toNum('abc'), 0);
  assert.equal(sc.toNum(undefined), 0);
  assert.equal(sc.toNum(null), 0);
  assert.equal(sc.toNum(NaN), 0);
  assert.equal(sc.toNum(Infinity), 0);
  assert.equal(sc.toNum('41-37'), 0);
});

test('variante con stock "4" + delta 1 → 5 numérico', async () => {
  await sc.reset(remeraWorld({ s: '4' }));
  const r = await sc.api('PUT', '/api/productos/REMERA/variantes/var_s/stock', { delta: 1, reason: 'test' });
  assert.equal(r.status, 200);
  assert.equal(r.body.stock, 5);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(typeof sc.stock('REMERA', 'var_s'), 'number');
});

test('delta como string "1" sobre stock "4" → 5', async () => {
  await sc.reset(remeraWorld({ s: '4' }));
  const r = await sc.api('PUT', '/api/productos/REMERA/variantes/var_s/stock', { delta: '1' });
  assert.equal(r.status, 200);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});

test('venta sobre stock "4" → 3 numérico y TN recibe número', async () => {
  await sc.reset(remeraWorld({ s: '4' }));
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }]);
  await sc.process('order/created', oid);
  assert.strictEqual(sc.stock('REMERA', 'var_s'), 3);
  await waitFor(() => sc.tn.getStock(1001) === 3 && sc.tn.getStock(2001) === 3);
  assert.strictEqual(sc.tn.putsToVariant(1001).at(-1).stock, 3);
});

test('cancel sobre stock "3" → 5 (no "32")', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([{ variant_id: 1001, quantity: 2 }]);
  await sc.process('order/created', oid);
  sc.db.get('productos').find({ id: 'REMERA' }).get('variantes').find({ id: 'var_s' }).assign({ stock: '3' }).write();
  await sc.process('order/cancelled', oid);
  assert.strictEqual(sc.stock('REMERA', 'var_s'), 5);
});

test('absolute negativo queda en 0', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const r = await sc.api('PUT', '/api/productos/REMERA/variantes/var_s/stock', { absolute: -3 });
  assert.equal(r.status, 200);
  assert.strictEqual(sc.stock('REMERA', 'var_s'), 0);
});
