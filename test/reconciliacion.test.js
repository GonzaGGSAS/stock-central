'use strict';
// i. Reconciliación (runReconcileCycle): SC es la fuente de verdad → se corrige TN, no SC.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, remeraWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

test('TN igual a SC → no cambia nada ni alerta', { timeout: 20000 }, async () => {
  await sc.reset(remeraWorld({ s: 5, m: 2 }));
  await sc.runReconcileCycle();
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(sc.stock('REMERA', 'var_m'), 2);
  assert.equal(sc.tn.getStock(1001), 5);
  assert.equal(sc.log('REMERA', 'var_s').filter(e => e.action === 'reconciled').length, 0);
});

test('[nuevo] TN distinto en el primer link → SC gana (se corrige TN) y alerta discrepancy', { timeout: 20000 }, async () => {
  await sc.reset(remeraWorld({ s: 5, m: 2 }));
  sc.tn.setStock(1001, 7);
  await sc.runReconcileCycle();

  assert.equal(sc.stock('REMERA', 'var_s'), 5, 'SC no se debería pisar con el número de TN');
  await waitFor(() => { assert.equal(sc.tn.getStock(1001), 5, 'TN debería corregirse a 5'); return true; });
  assert.equal(sc.tn.getStock(2001), 5);

  const alerts = await sc.alerts();
  const a = alerts.find(x => x.type === 'discrepancy' && x.varianteId === 'var_s');
  assert.ok(a, `falta alerta discrepancy: ${JSON.stringify(alerts)}`);
  assert.equal(a.productoId, 'REMERA');
});

test('[nuevo] TN distinto en el segundo link → también se corrige', { timeout: 20000 }, async () => {
  await sc.reset(remeraWorld({ s: 5, m: 2 }));
  sc.tn.setStock(2002, 9);
  await sc.runReconcileCycle();
  assert.equal(sc.stock('REMERA', 'var_m'), 2);
  await waitFor(() => { assert.equal(sc.tn.getStock(2002), 2, 'TN 2002 debería corregirse a 2'); return true; });
});

test('[nuevo] reconciliación respeta reservas: link con carrito ajeno queda en stock − reservado', { timeout: 20000 }, async () => {
  // stock 1 con una reserva activa vía L1 → lo esperado en TN es L1=1, L2=0
  await sc.reset(remeraWorld({
    s: 1, m: 2,
    reservations: [{ id: 'res_x', sessionId: 'sess-X', productoId: 'REMERA', varianteId: 'var_s', tnVariantId: '1001', qty: 1, expiresAt: Date.now() + 10 * 60 * 1000 }],
  }));
  await sc.runReconcileCycle();
  assert.equal(sc.stock('REMERA', 'var_s'), 1);
  await waitFor(() => { assert.equal(sc.tn.getStock(2001), 0); return true; });
  assert.equal(sc.tn.getStock(1001), 1);
});
