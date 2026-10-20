// POST /api/reserve/sync — el storefront v29 manda el carrito completo
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, remeraWorld, buzosWorld, waitFor } = require('./helpers');

let sc;
test.before(async () => { sc = await startServer(remeraWorld()); });
test.after(async () => { await sc.close(); });

const sync = (sid, items) => sc.api('POST', '/api/reserve/sync', { sessionId: sid, items });
const holdsOf = (sid) => sc.db.get('reservations').value().filter(r => r.sessionId === sid && r.expiresAt > Date.now());
const heldQty = (sid, ch) => holdsOf(sid).filter(r => String(r.tnVariantId) === String(ch)).reduce((a, r) => a + r.qty, 0);

test('carrito con un diseño → retiene; mismo carrito repetido → no duplica', async () => {
  await sc.reset(remeraWorld({ s: 1 }));
  let r = await sync('a', [{ variant_id: 1001, qty: 1 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(heldQty('a', 1001), 1);
  r = await sync('a', [{ variant_id: 1001, qty: 1 }]);
  assert.equal(heldQty('a', 1001), 1, 'el mismo carrito no suma de nuevo');
  await waitFor(() => sc.tn.getStock(2001) === 0);
  assert.equal(sc.tn.getStock(1001), 1);
});

test('EL CASO REAL: sacar el producto (la página recarga y manda carrito vacío) → libera y el otro diseño vuelve', async () => {
  await sc.reset(remeraWorld({ s: 1 }));
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  await waitFor(() => sc.tn.getStock(2001) === 0);
  const r = await sync('a', []);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.released, [{ variant_id: '1001', qty: 1 }]);
  assert.equal(holdsOf('a').length, 0);
  await waitFor(() => sc.tn.getStock(2001) === 1);
});

test('segundo diseño con 1 sola unidad → rechazado y no se retiene', async () => {
  await sc.reset(remeraWorld({ s: 1 }));
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  const r = await sync('a', [{ variant_id: 1001, qty: 1 }, { variant_id: 2001, qty: 1 }]);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.rejected[0].variant_id, '2001');
  assert.equal(heldQty('a', 2001), 0);
  assert.equal(heldQty('a', 1001), 1, 'el primero sigue retenido');
});

test('subir y bajar la cantidad: retiene exactamente lo del carrito', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  await sync('a', [{ variant_id: 1001, qty: 3 }]);
  assert.equal(heldQty('a', 1001), 3);
  await sync('a', [{ variant_id: 1001, qty: 2 }]);
  assert.equal(heldQty('a', 1001), 2);
  assert.equal(sc.allocation('REMERA', 'var_s').reserved, 2);
});

test('líneas repetidas de la misma variante (distinta personalización) se suman', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sync('a', [{ variant_id: 1001, qty: 1 }, { variant_id: 1001, qty: 1 }]);
  assert.equal(heldQty('a', 1001), 2);
});

test('sigue en el carrito → se renueva el vencimiento', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  const h = holdsOf('a')[0];
  h.expiresAt = Date.now() + 1000;
  sc.db.write();
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  assert.ok(holdsOf('a')[0].expiresAt > Date.now() + 10 * 60 * 1000, 'renovado a ~15 min');
});

test('reserva de 15 minutos por defecto', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const before = Date.now();
  await sync('a', [{ variant_id: 1001, qty: 1 }]);
  const ttl = holdsOf('a')[0].expiresAt - before;
  assert.ok(ttl > 14 * 60 * 1000 && ttl <= 15 * 60 * 1000 + 1000, `ttl ${ttl}`);
});

test('no toca reservas de otra sesión ni variantes no gestionadas', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sync('b', [{ variant_id: 1002, qty: 1 }]);
  const r = await sync('a', [{ variant_id: 999999, qty: 1 }]);
  assert.equal(r.status, 200);
  assert.equal(holdsOf('a').length, 0);
  assert.equal(heldQty('b', 1002), 1);
});

test('entradas inválidas → 400 sin tocar nada', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  assert.equal((await sc.api('POST', '/api/reserve/sync', { sessionId: 'a' })).status, 400);
  assert.equal((await sc.api('POST', '/api/reserve/sync', { items: [] })).status, 400);
  assert.equal((await sc.api('POST', '/api/reserve/sync', { sessionId: 'a', items: 'x' })).status, 400);
  const r = await sync('a', [{ variant_id: 1001, qty: -5 }, { variant_id: 1001, qty: 'abc' }, null]);
  assert.equal(r.status, 200);
  assert.equal(holdsOf('a').length, 0);
});

test('combo: entra y sale del carrito como una unidad', async () => {
  await sc.reset(buzosWorld({ cs: 3, cm: 2, ms: 2, mm: 0 }));
  let r = await sync('c', [{ variant_id: 9001, qty: 1 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sc.allocation('BUZO_CHANDLER', 'var_cs').reserved, 1);
  assert.equal(sc.allocation('BUZO_MONICA', 'var_ms').reserved, 1);
  r = await sync('c', [{ variant_id: 9001, qty: 1 }]);
  assert.equal(sc.allocation('BUZO_CHANDLER', 'var_cs').reserved, 1, 'repetir no duplica');
  r = await sync('c', []);
  assert.equal(sc.allocation('BUZO_CHANDLER', 'var_cs').reserved, 0);
  assert.equal(sc.allocation('BUZO_MONICA', 'var_ms').reserved, 0);
});
