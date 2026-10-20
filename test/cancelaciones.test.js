'use strict';
// b. Cancelaciones
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

const ITEM = qty => ({ variant_id: 1001, quantity: qty, name: 'REMERA A (Negro, S)' });

test('cancel después de venta devuelve el stock una vez', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM(2)]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);

  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  await waitFor(() => sc.tn.getStock(1001) === 5 && sc.tn.getStock(2001) === 5);
  const ret = sc.log('REMERA', 'var_s').filter(e => e.action === 'return');
  assert.equal(ret.length, 1);
  assert.equal(ret[0].order_id, String(oid));
  assert.equal(ret[0].delta, 2);
});

test('[nuevo] cancel DUPLICADO no devuelve dos veces', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM(2)]);
  await sc.process('order/created', oid);
  await sc.process('order/cancelled', oid);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5, 'el segundo cancel no debería sumar otra vez');
  assert.equal(sc.log('REMERA', 'var_s').filter(e => e.action === 'return').length, 1);
  await waitFor(() => sc.tn.getStock(1001) === 5 && sc.tn.getStock(2001) === 5);
});

test('cancel sin venta previa → se ignora', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM(2)]);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(sc.log('REMERA', 'var_s').filter(e => e.action === 'return').length, 0);
  assert.equal(sc.tn.putsToVariant(1001).length, 0, 'no debería empujar nada a TN');
});

test('venta → cancel → created repetido (retry tardío de TN) no vuelve a descontar', async () => {
  // Si TN reintenta order/created después de la cancelación, la orden ya está cancelada:
  // SC no debería descontar otra vez (la venta ya fue registrada y devuelta).
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([ITEM(2)]);
  await sc.process('order/created', oid);
  await sc.process('order/cancelled', oid);
  sc.tn.setOrder(oid, { status: 'cancelled' });
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});
