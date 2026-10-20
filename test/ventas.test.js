'use strict';
// a. Ventas de producto normal + idempotencia created/paid
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

const ITEM_S_A = qty => ({ variant_id: 1001, quantity: qty, name: 'REMERA A (Negro, S)' });

test('order/created qty 2: SC 5→3, TN PUT 3 en todos los links, log sale', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM_S_A(2)], { contact_name: 'Florencia P.' });

  await sc.process('order/created', oid);

  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  await waitFor(() => sc.tn.getStock(1001) === 3 && sc.tn.getStock(2001) === 3);
  assert.deepEqual(sc.tn.putsToVariant(1001).at(-1), { stock: 3 });
  assert.deepEqual(sc.tn.putsToVariant(2001).at(-1), { stock: 3 });
  // no toca la otra variante
  assert.equal(sc.stock('REMERA', 'var_m'), 5);
  assert.equal(sc.tn.putsToVariant(1002).length, 0);

  const sale = sc.log('REMERA', 'var_s').find(e => e.action === 'sale');
  assert.ok(sale, 'falta log sale');
  assert.equal(sale.order_id, String(oid));
  assert.equal(sale.tn_variant_id, '1001');
  assert.equal(sale.delta, -2);
  assert.equal(sale.stock, 3);
});

test('order/created repetido no descuenta dos veces', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM_S_A(2)]);
  await sc.process('order/created', oid);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  assert.equal(sc.log('REMERA', 'var_s').filter(e => e.action === 'sale').length, 1);
});

test('order/paid después de created → payment_confirmed sin tocar stock', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM_S_A(2)]);
  await sc.process('order/created', oid);
  await sc.process('order/paid', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  const log = sc.log('REMERA', 'var_s');
  assert.equal(log.filter(e => e.action === 'sale').length, 1);
  const pc = log.find(e => e.action === 'payment_confirmed');
  assert.ok(pc, 'falta log payment_confirmed');
  assert.equal(pc.order_id, String(oid));
  assert.equal(pc.delta, 0);
});

test('order/paid sin created previo → descuenta', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM_S_A(1)]);
  await sc.process('order/paid', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  await waitFor(() => sc.tn.getStock(1001) === 4 && sc.tn.getStock(2001) === 4);
  const sale = sc.log('REMERA', 'var_s').find(e => e.action === 'sale');
  assert.ok(sale);
  assert.equal(sale.order_id, String(oid));
});

test('POST /webhook/order responde 200 y procesa en background', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM_S_A(1)]);
  const r = await sc.api('POST', '/webhook/order', { event: 'order/created', id: oid, store_id: 1 });
  assert.equal(r.status, 200);
  await waitFor(() => sc.stock('REMERA', 'var_s') === 4);
  await waitFor(() => sc.tn.getStock(1001) === 4 && sc.tn.getStock(2001) === 4);
});

test('venta con reserva activa la consume y descuenta una sola vez', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const r = await sc.reserve('sess-venta', 1001, 2);
  assert.equal(r.status, 200);
  assert.equal(sc.reservations().length, 1);
  const oid = sc.order([ITEM_S_A(2)]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  assert.equal(sc.reservations().length, 0, 'la reserva debería consumirse con la venta');
  await waitFor(() => sc.tn.getStock(1001) === 3 && sc.tn.getStock(2001) === 3);
});
