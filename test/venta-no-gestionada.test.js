'use strict';
// f. Venta de una variante de TN que no está vinculada en SC → alerta unlinked_sale
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, remeraWorld, combine } = require('./helpers');

const world = () => combine(remeraWorld({ s: 5 }), {
  tnProducts: [{ id: 700, name: 'GORRA SUELTA', variants: [{ id: 7777, values: ['Única'], stock: 4 }] }],
});

let sc;
before(async () => { sc = await startServer(world()); });
after(async () => { await sc.close(); });

test('venta no gestionada no toca el stock de SC', async () => {
  await sc.reset(world());
  const oid = sc.order([{ variant_id: 7777, quantity: 1, name: 'GORRA SUELTA' }]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(sc.tn.putsToVariant(7777).length, 0);
});

test('[nuevo] venta no gestionada → alerta unlinked_sale en /api/alerts', async () => {
  await sc.reset(world());
  const oid = sc.order([{ variant_id: 7777, quantity: 1, name: 'GORRA SUELTA' }]);
  await sc.process('order/created', oid);
  const alerts = await sc.alerts();
  const a = alerts.find(x => x.type === 'unlinked_sale' && String(x.order_id) === String(oid));
  assert.ok(a, `falta alerta unlinked_sale: ${JSON.stringify(alerts)}`);
  assert.equal(String(a.variant_id), '7777');
  assert.ok(['error', 'warning'].includes(a.severity));
  assert.equal(typeof a.title, 'string');
  assert.equal(a.dismissed, false);
});

test('[nuevo] orden mixta (gestionada + no gestionada): descuenta la gestionada y alerta la otra', async () => {
  await sc.reset(world());
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }, { variant_id: 7777, quantity: 1 }]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  const alerts = await sc.alerts();
  assert.ok(alerts.some(x => x.type === 'unlinked_sale' && String(x.order_id) === String(oid)));
});
