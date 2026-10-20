'use strict';
/**
 * d. EL BUG REPORTADO — reservas con SKU compartido (comportamiento esperado nuevo).
 *
 * Variante SC con stock 1 vinculada a dos productos de TN (L1 = 1001, L2 = 2001).
 * Cuando alguien reserva vía L1, SC tiene que empujar a TN: L1 = 1 (el diseño que está
 * en el carrito conserva su unidad) y L2 = 0 (nadie más puede agregar el otro diseño).
 * Fórmula: stock TN del link L = stock SC − reservas activas hechas vía OTROS links.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

const L1 = 1001, L2 = 2001;
const resOf = (sessionId, tnVariantId) =>
  sc.reservations().filter(r => r.sessionId === sessionId && (tnVariantId == null || r.tnVariantId === String(tnVariantId)));

test('[nuevo] reservar vía L1 con stock 1 → TN L1=1, L2=0', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  const r = await sc.reserve('sess-A', L1, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(resOf('sess-A', L1).length, 1);
  assert.equal(sc.stock('REMERA', 'var_s'), 1, 'la reserva no descuenta stock físico');

  await waitFor(() => { assert.equal(sc.tn.getStock(L2), 0, 'TN L2 debería quedar en 0'); return true; });
  assert.equal(sc.tn.getStock(L1), 1, 'TN L1 debería conservar la unidad del carrito');
  assert.ok(!sc.tn.putsToVariant(L1).some(b => b.stock === 0), 'nunca se debería empujar L1=0');
});

test('[nuevo] la misma sesión reserva vía L2 → 409 sin crear reserva', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  assert.equal((await sc.reserve('sess-A', L1, 1)).status, 200);
  const r = await sc.reserve('sess-A', L2, 1);
  assert.equal(r.status, 409, `esperaba 409, vino ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.equal(resOf('sess-A', L2).length, 0, 'no debería crear reserva vía L2');
  assert.equal(resOf('sess-A').length, 1);
});

test('[nuevo] otra sesión reserva L1 con la unidad ya en un carrito → 409', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  assert.equal((await sc.reserve('sess-A', L1, 1)).status, 200);
  const r = await sc.reserve('sess-B', L1, 1);
  assert.equal(r.status, 409, `esperaba 409, vino ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.equal(resOf('sess-B').length, 0);
});

test('[nuevo] si igual llega una orden con L1 y L2 → SC 0 y alerta oversold', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  assert.equal((await sc.reserve('sess-A', L1, 1)).status, 200);
  const oid = sc.order([
    { variant_id: L1, quantity: 1, name: 'REMERA A (Negro, S)' },
    { variant_id: L2, quantity: 1, name: 'REMERA B (Negro, S)' },
  ]);
  await sc.process('order/created', oid);

  assert.equal(sc.stock('REMERA', 'var_s'), 0);
  await waitFor(() => sc.tn.getStock(L1) === 0 && sc.tn.getStock(L2) === 0);
  const alerts = await sc.alerts();
  const a = alerts.find(x => x.type === 'oversold' && String(x.order_id) === String(oid));
  assert.ok(a, `falta alerta oversold para la orden ${oid}: ${JSON.stringify(alerts)}`);
  assert.equal(a.severity, 'error');
  assert.equal(a.productoId, 'REMERA');
  assert.equal(a.varianteId, 'var_s');
  assert.equal(a.dismissed, false);
});

test('[nuevo] al expirar la reserva → TN vuelve a L1=1, L2=1', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  assert.equal((await sc.reserve('sess-A', L1, 1)).status, 200);
  await sc.tn.idle();
  // Estado que debería haber dejado la reserva (lo forzamos por si todavía no se implementó)
  sc.tn.setStock(L1, 1); sc.tn.setStock(L2, 0);

  const [res] = resOf('sess-A', L1);
  sc.db.get('reservations').find({ id: res.id }).assign({ expiresAt: Date.now() - 1000 }).write();
  await sc.releaseExpiredReservations();

  assert.equal(sc.reservations().length, 0);
  assert.equal(sc.stock('REMERA', 'var_s'), 1);
  await waitFor(() => { assert.equal(sc.tn.getStock(L2), 1, 'TN L2 debería volver a 1'); return true; });
  assert.equal(sc.tn.getStock(L1), 1);
});

test('[nuevo] al liberar la reserva (DELETE /api/reserve/:sessionId) → TN vuelve a L1=1, L2=1', async () => {
  await sc.reset(remeraWorld({ s: 1, m: 5 }));
  assert.equal((await sc.reserve('sess-A', L1, 1)).status, 200);
  await sc.tn.idle();
  sc.tn.setStock(L1, 1); sc.tn.setStock(L2, 0);

  const r = await sc.release('sess-A');
  assert.equal(r.status, 200);
  assert.equal(r.body.released, 1);
  assert.equal(sc.reservations().length, 0);
  await waitFor(() => { assert.equal(sc.tn.getStock(L2), 1, 'TN L2 debería volver a 1'); return true; });
  assert.equal(sc.tn.getStock(L1), 1);
});

test('[nuevo] stock 5 y reserva qty 2 vía L1 → TN L1=5, L2=3', async () => {
  await sc.reset(remeraWorld({ s: 5, m: 5 }));
  const r = await sc.reserve('sess-A', L1, 2);
  assert.equal(r.status, 200);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  await waitFor(() => { assert.equal(sc.tn.getStock(L2), 3, 'TN L2 debería ser 5 − 2'); return true; });
  assert.equal(sc.tn.getStock(L1), 5);
  // y no toca la otra variante
  assert.equal(sc.tn.putsToVariant(1002).length + sc.tn.putsToVariant(2002).length, 0);
});

test('reserva vía L1 dentro del stock (actual): 200, sin descontar stock físico', async () => {
  await sc.reset(remeraWorld({ s: 5, m: 5 }));
  const r = await sc.reserve('sess-A', L1, 2);
  assert.equal(r.status, 200);
  assert.equal(r.body.managed, true);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  const [res] = resOf('sess-A', L1);
  assert.equal(res.qty, 2);
  assert.equal(res.productoId, 'REMERA');
  assert.equal(res.varianteId, 'var_s');
  assert.ok(res.expiresAt > Date.now());
});

test('reserva sin stock (stock 0) → 409', async () => {
  await sc.reset(remeraWorld({ s: 0, m: 5 }));
  const r = await sc.reserve('sess-A', L1, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(sc.reservations().length, 0);
});
