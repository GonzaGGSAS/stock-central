'use strict';
// c. SKU compartido: 2 productos de TN (dos diseños) → misma variante SC
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

test('orden con line items de ambos productos TN descuenta los dos', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([
    { variant_id: 1001, quantity: 1, name: 'REMERA A (Negro, S)' },
    { variant_id: 2001, quantity: 1, name: 'REMERA B (Negro, S)' },
  ]);
  await sc.process('order/created', oid);

  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  await waitFor(() => sc.tn.getStock(1001) === 3 && sc.tn.getStock(2001) === 3);
  const sales = sc.log('REMERA', 'var_s').filter(e => e.action === 'sale');
  assert.deepEqual(sales.map(s => s.tn_variant_id).sort(), ['1001', '2001']);
  assert.ok(sales.every(s => s.order_id === String(oid)));
});

test('retry de la misma orden con SKU compartido no repite descuentos', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([
    { variant_id: 1001, quantity: 1 },
    { variant_id: 2001, quantity: 2 },
  ]);
  await sc.process('order/created', oid);
  await sc.process('order/created', oid);
  await sc.process('order/paid', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 2);
  assert.equal(sc.log('REMERA', 'var_s').filter(e => e.action === 'sale').length, 2);
});

test('cancel de orden con SKU compartido devuelve ambos line items', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([
    { variant_id: 1001, quantity: 1 },
    { variant_id: 2001, quantity: 2 },
  ]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 2);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});
