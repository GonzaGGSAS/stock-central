'use strict';
/**
 * e. Matchs (combos de dos buzos con un producto contenedor en TN).
 * Mundo: CS=3, CM=2, MS=2, MM=0. Contenedor 900: 9001 S/S, 9002 S/M, 9003 M/S, 9004 M/M.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, buzosWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(buzosWorld()); });
after(async () => { await sc.close(); });

const QUIET = { quietMs: 900 }; // los syncs de matchs tienen pausas de hasta 800ms
const resOf = sessionId => sc.reservations().filter(r => r.sessionId === sessionId);

test('[nuevo] reservar el combo crea holds en las DOS variantes individuales sin descontar stock', async () => {
  await sc.reset(buzosWorld(), QUIET);
  const r = await sc.reserve('sess-M', 9001, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.managed, true);

  const holds = resOf('sess-M');
  assert.equal(holds.length, 2, `esperaba 2 reservas, hay ${holds.length}`);
  assert.deepEqual(holds.map(h => h.varianteId).sort(), ['var_cs', 'var_ms']);
  assert.ok(holds.every(h => h.qty === 1));

  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3, 'la reserva del combo no debería descontar stock físico');
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2, 'la reserva del combo no debería descontar stock físico');
});

test('[nuevo] combo con una variante sin disponible → 409 y no crea ninguna reserva', async () => {
  await sc.reset(buzosWorld(), QUIET); // MM = 0
  const r = await sc.reserve('sess-M', 9004, 1); // M/M → CM (2) + MM (0)
  assert.equal(r.status, 409, `esperaba 409, vino ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.equal(resOf('sess-M').length, 0, 'no debería reservar CM si MM no tiene');
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cm'), 2);
});

test('venta del combo: cada individual −qty y contenedor = min', async () => {
  await sc.reset(buzosWorld(), QUIET);
  const oid = sc.order([{ variant_id: 9001, quantity: 1, name: 'BUZOS CHANDLER + MONICA (S / S)' }]);
  await sc.process('order/created', oid);

  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 1);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cm'), 2);
  await waitFor(() => sc.tn.getStock(3001) === 2 && sc.tn.getStock(4001) === 1);
  await waitFor(() => {
    assert.equal(sc.tn.getStock(9001), 1); // min(2, 1)
    assert.equal(sc.tn.getStock(9002), 0); // min(2, 0)
    assert.equal(sc.tn.getStock(9003), 1); // min(2, 1)
    assert.equal(sc.tn.getStock(9004), 0);
    return true;
  });
  const sale = sc.log('BUZO_CHANDLER', 'var_cs').find(e => e.action === 'sale');
  assert.ok(sale);
  assert.equal(sale.order_id, String(oid));
  assert.equal(sale.tn_variant_id, '9001');
});

test('reserva del combo + venta: reservas consumidas, cada individual −qty una sola vez', async () => {
  await sc.reset(buzosWorld(), QUIET);
  assert.equal((await sc.reserve('sess-M', 9001, 1)).status, 200);
  await sc.tn.idle(900);
  const oid = sc.order([{ variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);

  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 1);
  assert.equal(resOf('sess-M').length, 0, 'las reservas del combo deberían consumirse');
  await waitFor(() => sc.tn.getStock(9001) === 1);
});

test('venta del combo es idempotente (created ×2 + paid)', async () => {
  await sc.reset(buzosWorld(), QUIET);
  const oid = sc.order([{ variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);
  await sc.process('order/created', oid);
  await sc.process('order/paid', oid);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 1);
  assert.equal(sc.log('BUZO_CHANDLER', 'var_cs').filter(e => e.action === 'sale').length, 1);
});

test('cancel del combo devuelve a las dos individuales', async () => {
  await sc.reset(buzosWorld(), QUIET);
  const oid = sc.order([{ variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
  await waitFor(() => sc.tn.getStock(3001) === 3 && sc.tn.getStock(4001) === 2 && sc.tn.getStock(9001) === 2);
});

test('[nuevo] cancel DUPLICADO del combo no devuelve dos veces', async () => {
  await sc.reset(buzosWorld(), QUIET);
  const oid = sc.order([{ variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);
  await sc.process('order/cancelled', oid);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
});

test('combo y después individual de la misma variante (stock 1) en el mismo carrito → el segundo se rechaza', async () => {
  await sc.reset(buzosWorld({ cs: 1 }), QUIET);
  assert.equal((await sc.reserve('sess-M', 9001, 1)).status, 200);
  const r = await sc.reserve('sess-M', 3001, 1);
  assert.equal(r.status, 409, `esperaba 409, vino ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
});

test('[nuevo] individual y después combo de la misma variante (stock 1) → el combo se rechaza sin reservar nada', async () => {
  await sc.reset(buzosWorld({ cs: 1 }), QUIET);
  assert.equal((await sc.reserve('sess-M', 3001, 1)).status, 200);
  const before = resOf('sess-M').length;
  const r = await sc.reserve('sess-M', 9001, 1);
  assert.equal(r.status, 409, `esperaba 409, vino ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.equal(resOf('sess-M').length, before, 'no debería quedar un hold suelto en MONICA');
});
