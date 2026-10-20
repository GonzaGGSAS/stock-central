'use strict';
/**
 * Revisión adversarial del núcleo de stock (asignación por canal, holds, órdenes, migración).
 *
 * Convención: los tests marcados { todo } describen el comportamiento CORRECTO y hoy fallan
 * (demuestran un problema encontrado). node:test los corre y los reporta, pero no rompen la suite.
 * Los tests sin todo tienen que pasar.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { startServer, waitFor, remeraWorld, buzosWorld, combine, clone } = require('./helpers');

let sc;
before(async () => { sc = await startServer(remeraWorld()); });
after(async () => { await sc.close(); });

const QUIET = { quietMs: 400 };
const holdsOf = sessionId => sc.reservations().filter(r => r.sessionId === sessionId);
// tn.idle() solo mira actividad pasada: si el sync todavía no arrancó (import de node-fetch, cola) vuelve enseguida
const settle = async () => { await new Promise(r => setTimeout(r, 150)); await sc.tn.idle(); };
const sumTN = ids => ids.reduce((a, id) => a + (sc.tn.getStock(id) || 0), 0);
function tnVariantObj(pid, vid) {
  return sc.tn.state.products.get(Number(pid)).variants.find(v => String(v.id) === String(vid));
}
// Hace que los PUT a esa variante del TN falso respondan 500 (el setter tira dentro del router)
function breakVariant(pid, vid) {
  const v = tnVariantObj(pid, vid);
  let val = v.stock;
  Object.defineProperty(v, 'stock', {
    configurable: true, enumerable: true,
    get() { return val; },
    set() { throw new Error('boom (500 simulado)'); },
  });
  return () => Object.defineProperty(v, 'stock', { value: val, writable: true, enumerable: true, configurable: true });
}
function linkObj(productoId, varianteId, tnVid) {
  return sc.db.get('productos').find({ id: productoId }).get('variantes').find({ id: varianteId }).value()
    .links.find(l => String(l.variant_id) === String(tnVid));
}

// ════════════════════════════════════════════════════════════════════════════
// 1. POST /api/reserve con entradas basura
// ════════════════════════════════════════════════════════════════════════════
test('reserve: qty -100 / 0 / "abc" / 1e9 y sessionId numérico u objeto no tiran el proceso ni cambian stock', async () => {
  await sc.reset(remeraWorld({ s: 5, m: 5 }));
  const bodies = [
    { sessionId: 'q-neg', variant_id: '1001', qty: -100 },
    { sessionId: 'q-0', variant_id: '1001', qty: 0 },
    { sessionId: 'q-abc', variant_id: '1001', qty: 'abc' },
    { sessionId: 'q-big', variant_id: '1001', qty: 1e9 },
    { sessionId: 12345, variant_id: 1001, qty: 1 },
    { sessionId: { a: 1 }, variant_id: '2001', qty: 1 },
    { sessionId: 'q-obj-var', variant_id: { x: 1 }, qty: 1 },
    { sessionId: 'q-arr', variant_id: '1001', qty: [1, 2] },
  ];
  for (const b of bodies) {
    const r = await sc.api('POST', '/api/reserve', b);
    assert.ok(r.status < 500, `${JSON.stringify(b)} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  const bad = await fetch(sc.baseUrl + '/api/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sessionId":' });
  assert.equal(bad.status, 400);
  assert.equal((await sc.api('GET', '/api/health')).status, 200, 'el proceso sigue vivo');
  assert.equal(sc.stock('REMERA', 'var_s'), 5, 'una reserva nunca cambia stock físico');
  const big = holdsOf('q-big');
  assert.ok(big.length === 0, '1e9 no reserva');
  assert.ok(sc.reservations().every(r => r.qty >= 1 && r.qty <= 50));
  // el sessionId numérico queda como string y se puede liberar
  assert.equal(holdsOf('12345').length, 1);
  assert.equal((await sc.release('12345')).body.released, 1);
});

test('reserve: qty inválido (-100, 0, "abc", 1e9, 2.5) responde 400 y no crea reserva', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const r1 = await sc.api('POST', '/api/reserve', { sessionId: 'q-neg', variant_id: '1001', qty: -100 });
  const r2 = await sc.api('POST', '/api/reserve', { sessionId: 'q-abc', variant_id: '1001', qty: 'abc' });
  assert.equal(r1.status, 400);
  assert.equal(r2.status, 400);
  for (const qty of [0, 1e9, 2.5, '']) assert.equal((await sc.api('POST', '/api/reserve', { sessionId: 'q-abc', variant_id: '1001', qty })).status, 400, `qty ${qty}`);
  assert.equal(holdsOf('q-neg').length + holdsOf('q-abc').length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Combos que comparten una variante + la variante suelta
// ════════════════════════════════════════════════════════════════════════════
// Chandler M (var_cm) con stock 1 está en: 3002 (suelto), 9003 (M/S) y 9004 (M/M)
const CM_CHANNELS = [3002, 9003, 9004];
const shared = () => buzosWorld({ cs: 3, cm: 1, ms: 2, mm: 2 });

test('combos (M,S) y (M,M) + buzo M suelto con stock 1: solo se reserva uno y TN suma 1 entre esos canales', async () => {
  await sc.reset(shared(), QUIET);
  const a = await sc.reserve('s1', 9004, 1);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await sc.reserve('s2', 9003, 1)).status, 409, 'otro combo con el mismo buzo M');
  assert.equal((await sc.reserve('s3', 3002, 1)).status, 409, 'el buzo M suelto');
  assert.equal((await sc.reserve('s1', 3002, 1)).status, 409, 'la misma sesión tampoco se lleva un segundo');
  assert.equal((await sc.reserve('s1', 9003, 1)).status, 409, 'combo + otro combo en el mismo carrito');
  await settle();
  await waitFor(() => { assert.equal(sumTN(CM_CHANNELS), 1, `TN: ${CM_CHANNELS.map(id => `${id}=${sc.tn.getStock(id)}`).join(' ')}`); return true; });
  assert.equal(sc.tn.getStock(9004), 1, 'el combo que está en el carrito conserva su unidad');
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cm'), 1);
});

test('combo + individual en el mismo carrito: el segundo es 409 y el combo conserva la unidad', async () => {
  await sc.reset(shared(), QUIET);
  assert.equal((await sc.reserve('s1', 3002, 1)).status, 200);
  assert.equal((await sc.reserve('s1', 9004, 1)).status, 409);
  assert.equal(holdsOf('s1').length, 1, 'el combo no dejó un hold a medias en Monica M');
  await waitFor(() => sc.tn.getStock(9003) === 0 && sc.tn.getStock(9004) === 0, 5000).catch(() => {});
  await settle();
  assert.equal(sc.tn.getStock(3002), 1);
  assert.equal(sc.tn.getStock(9003), 0);
  assert.equal(sc.tn.getStock(9004), 0);
});

test('si igual llegan órdenes de los 3 canales (sin holds): SC vende 1, alerta sobreventa y TN queda en 0', async () => {
  await sc.reset(shared(), QUIET);
  for (const vid of CM_CHANNELS) await sc.process('order/created', sc.order([{ variant_id: vid, quantity: 1 }]));
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cm'), 0);
  const over = (await sc.alerts()).filter(a => a.type === 'oversold' && a.varianteId === 'var_cm');
  assert.equal(over.length, 2);
  await settle();
  assert.equal(sumTN(CM_CHANNELS), 0);
});

test('sin ningún carrito, TN no debería mostrar entre los canales más unidades que el stock real', { todo: 'MEDIO (límite del diseño): libre se muestra en TODOS los canales; sin hold suman 3 con stock 1' }, async () => {
  await sc.reset(shared(), QUIET);
  await sc.syncVariante('BUZO_CHANDLER', 'var_cm', null, { force: true });
  await settle();
  assert.ok(sumTN(CM_CHANNELS) <= 1, `TN suma ${sumTN(CM_CHANNELS)} con stock 1`);
});

test('DELETE /api/reserve?variant_id=<combo> no libera las reservas de otro combo de la misma sesión', async () => {
  await sc.reset(buzosWorld(), QUIET); // CS 3, CM 2, MS 2, MM 0
  assert.equal((await sc.reserve('sx', 9001, 1)).status, 200); // CS + MS
  assert.equal((await sc.reserve('sx', 9003, 1)).status, 200); // CM + MS
  assert.equal(holdsOf('sx').length, 4);
  const r = await sc.release('sx', 9001);
  assert.equal(r.body.released, 2);
  const left = holdsOf('sx');
  assert.equal(left.length, 2);
  assert.ok(left.every(h => h.tnVariantId === '9003'));
  assert.deepEqual(left.map(h => h.varianteId).sort(), ['var_cm', 'var_ms']);
});

test('combo con los dos lados del mismo stock: retiene 2, y con stock 1 es 409', async () => {
  // REMERA A M (1002) + REMERA B M (2002) → los dos lados salen de var_m
  const w = remeraWorld({ s: 5, m: 1 });
  w.seed.matchs = [{
    id: 'm_same', nombre: 'DOS REMERAS M', tn_match_product_id: '950', createdAt: '2026-01-01T00:00:00.000Z',
    producto1: { tn_product_id: '100' }, producto2: { tn_product_id: '200' },
    variantMap: [{ v1id: '1002', v2id: '2002', label: 'M / M', tn_variant_id: '9501' }],
  }];
  w.tnProducts.push({ id: 950, name: 'DOS REMERAS', variants: [{ id: 9501, values: ['M', 'M'], stock: 1 }] });
  await sc.reset(w, QUIET);
  assert.equal((await sc.reserve('sm', 9501, 1)).status, 409);
  await waitFor(() => sc.tn.getStock(9501) === 0); // floor(1/2) = 0
  await settle();

  const w3 = clone(w); w3.seed.productos[0].variantes[1].stock = 3;
  await sc.reset(w3, QUIET);
  assert.equal((await sc.reserve('sm', 9501, 1)).status, 200);
  const h = holdsOf('sm');
  assert.equal(h.length, 1);
  assert.equal(h[0].qty, 2);
  const oid = sc.order([{ variant_id: 9501, quantity: 1 }]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_m'), 1);
  assert.equal(holdsOf('sm').length, 0, 'la venta consume el hold del combo');
  await sc.process('order/cancelled', oid);
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_m'), 3);
});

test('la venta consume el hold de SU canal, no el de otro diseño', async () => {
  await sc.reset(remeraWorld({ s: 2 }));
  assert.equal((await sc.reserve('a', 1001, 1)).status, 200);
  assert.equal((await sc.reserve('b', 2001, 1)).status, 200);
  await sc.process('order/created', sc.order([{ variant_id: 1001, quantity: 1 }]));
  assert.equal(holdsOf('a').length, 0);
  assert.equal(holdsOf('b').length, 1);
  await waitFor(() => sc.tn.getStock(1001) === 0, 5000).catch(() => {});
  await settle();
  assert.equal(sc.tn.getStock(2001), 1, 'b sigue pudiendo pagar');
  assert.equal(sc.tn.getStock(1001), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Idempotencia de órdenes
// ════════════════════════════════════════════════════════════════════════════
test('tres order/cancelled seguidos (normal y combo) devuelven una sola vez', async () => {
  await sc.reset(combine(remeraWorld({ s: 5 }), buzosWorld()), QUIET);
  const oid = sc.order([{ variant_id: 1001, quantity: 2 }, { variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 1);
  for (let i = 0; i < 3; i++) await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
  // y en paralelo
  const oid2 = sc.order([{ variant_id: 1001, quantity: 1 }, { variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid2);
  sc.tn.setOrder(oid2, { status: 'cancelled' });
  await Promise.all([1, 2, 3].map(() => sc.processOrderEvent('order/cancelled', oid2)));
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
});

test('order/cancelled con la orden NO cancelada en TN no devuelve', async () => {
  await sc.reset(combine(remeraWorld({ s: 5 }), buzosWorld()), QUIET);
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }, { variant_id: 9001, quantity: 1 }]);
  await sc.process('order/created', oid);
  const r = await sc.processOrderEvent('order/cancelled', oid); // TN sigue "open"
  assert.equal(r.changed, false);
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
});

test('created x3 en paralelo y paid antes que created descuentan una sola vez', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }]);
  await Promise.all([1, 2, 3].map(() => sc.processOrderEvent('order/created', oid)));
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  const oid2 = sc.order([{ variant_id: 2001, quantity: 1 }]);
  await sc.processOrderEvent('order/paid', oid2);
  await sc.processOrderEvent('order/created', oid2);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
});

test('order/created que llega DESPUÉS de order/cancelled (orden cancelada en TN) no descuenta', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }]);
  sc.tn.setOrder(oid, { status: 'cancelled' });
  await sc.processOrderEvent('order/cancelled', oid); // no había venta: se ignora
  await sc.processOrderEvent('order/created', oid);   // retry tardío de TN
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});

test('cancelación de una venta hecha antes de re-vincular el link devuelve', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([{ variant_id: 1001, quantity: 1 }]);
  await sc.process('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  linkObj('REMERA', 'var_s', 1001).linked_at = new Date(Date.now() + 60e3).toISOString(); // se desvinculó y re-vinculó
  sc.db.write();
  await sc.process('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});

test('la revisión de órdenes no re-alerta en cada corrida (unlinked_sale count = 1)', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  sc.tn.addProduct({ id: 555, name: 'GORRA', variants: [{ id: 5551, values: ['U'], stock: 9 }] });
  sc.db.set('meta.catchup_since', new Date(Date.now() - 3600e3).toISOString()).write();
  const oid = sc.order([{ variant_id: 5551, quantity: 1, name: 'GORRA' }]);
  for (let i = 0; i < 3; i++) await sc.catchUpOrders();
  const a = (await sc.alerts()).find(x => x.type === 'unlinked_sale' && x.order_id === String(oid));
  assert.ok(a);
  assert.equal(a.count, 1, `count=${a.count}`);
});

test('webhook con TN_APP_SECRET: sin firma 401, con firma válida procesa', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  process.env.TN_APP_SECRET = 'secreto-test';
  try {
    const oid = sc.order([{ variant_id: 1001, quantity: 1 }]);
    const body = JSON.stringify({ event: 'order/created', id: oid, store_id: 1 });
    const r1 = await fetch(sc.baseUrl + '/webhook/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r1.status, 401);
    const sig = crypto.createHmac('sha256', 'secreto-test').update(body).digest('hex');
    const r2 = await fetch(sc.baseUrl + '/webhook/order', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-linkedstore-hmac-sha256': sig }, body });
    assert.equal(r2.status, 200);
    await waitFor(() => sc.stock('REMERA', 'var_s') === 4);
  } finally { delete process.env.TN_APP_SECRET; }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Asignación cuando lo reservado supera al stock
// ════════════════════════════════════════════════════════════════════════════
test('si se baja el stock por debajo de lo reservado, TN no suma más que el stock (reparto por orden de llegada)', async () => {
  await sc.reset(remeraWorld({ s: 2 }));
  assert.equal((await sc.reserve('a', 1001, 1)).status, 200);
  assert.equal((await sc.reserve('b', 2001, 1)).status, 200);
  const r = await sc.api('PUT', '/api/productos/REMERA/variantes/var_s/stock', { absolute: 1, sync: true, reason: 'conteo' });
  assert.equal(r.status, 200);
  await settle();
  assert.ok(sumTN([1001, 2001]) <= 1, `TN 1001=${sc.tn.getStock(1001)} 2001=${sc.tn.getStock(2001)} con stock 1`);
  assert.equal(sc.tn.getStock(1001), 1, 'el primero que reservó conserva la unidad');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Migración de datos viejos
// ════════════════════════════════════════════════════════════════════════════
function legacyComboWorld() {
  // Producción: la reserva vieja del combo 9001 (CS + MS) ya descontó 1 de cada lado
  const w = buzosWorld({ cs: 2, cm: 2, ms: 1, mm: 0 });
  const exp = Date.now() + 20 * 60e3;
  w.seed.reservations = [
    { id: 'res_match_old1', sessionId: 'old-sess', productoId: 'BUZO_CHANDLER', varianteId: 'var_cs', tnVariantId: '3001', qty: 1, expiresAt: exp, matchReservationId: 'mres_1' },
    { id: 'res_match_old2', sessionId: 'old-sess', productoId: 'BUZO_MONICA', varianteId: 'var_ms', tnVariantId: '4001', qty: 1, expiresAt: exp, matchReservationId: 'mres_1' },
    { id: 'res_old_normal', sessionId: 'old-2', productoId: 'BUZO_CHANDLER', varianteId: 'var_cm', tnVariantId: '3002', qty: 1, expiresAt: exp },
  ];
  return w;
}

test('migración: reserva vieja de combo devuelve el stock UNA vez y queda como hold del contenedor', async () => {
  await sc.reset(legacyComboWorld(), QUIET);
  sc.migrateDb();
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
  sc.migrateDb(); // reinicio: no repite
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
  const old = holdsOf('old-sess');
  assert.equal(old.length, 2);
  assert.ok(old.every(h => h.kind === 'hold' && h.tnVariantId === '9001'));
  assert.equal(holdsOf('old-2')[0].kind, 'hold');
  assert.equal(holdsOf('old-2')[0].tnVariantId, '3002');
  // el carrito viejo puede pagar: el contenedor 9001 conserva su unidad
  const alloc = sc.allocation('BUZO_MONICA', 'var_ms');
  assert.equal(alloc.free, 1);
  assert.equal(sc.channelStock(alloc, '9001'), 2);
  // vence: no vuelve a sumar
  for (const r of sc.db.get('reservations').value()) r.expiresAt = Date.now() - 1;
  sc.db.write();
  await sc.releaseExpiredReservations();
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 3);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 2);
  assert.equal(sc.reservations().length, 0);
});

test('migración: la venta del carrito viejo descuenta una sola vez (no doble con la reserva)', async () => {
  await sc.reset(legacyComboWorld(), QUIET);
  sc.migrateDb();
  await sc.process('order/created', sc.order([{ variant_id: 9001, quantity: 1 }]));
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 2);
  assert.equal(sc.stock('BUZO_MONICA', 'var_ms'), 1);
  assert.equal(holdsOf('old-sess').length, 0);
});

test('migración: combo viejo con un lado no gestionado debería quedar retenido en su contenedor', { todo: 'BAJO: con 1 sola reserva en el grupo el canal queda null y el contenedor muestra 0 al dueño del carrito' }, async () => {
  const w = legacyComboWorld();
  w.seed.productos = w.seed.productos.filter(p => p.id !== 'BUZO_MONICA'); // Monica no está en SC
  w.seed.productos[0].variantes[0].stock = 0; // CS: 1 − 1 reservado por el combo viejo
  w.seed.reservations = [w.seed.reservations[0]];
  await sc.reset(w, QUIET);
  sc.migrateDb();
  assert.equal(sc.stock('BUZO_CHANDLER', 'var_cs'), 1);
  assert.equal(holdsOf('old-sess')[0].tnVariantId, '9001');
});

test('holds nuevos de combo no llevan matchReservationId (rollback a 66fbbdf no suma stock fantasma)', async () => {
  await sc.reset(buzosWorld(), QUIET);
  assert.equal((await sc.reserve('rb', 9001, 1)).status, 200);
  assert.ok(holdsOf('rb').every(h => !h.matchReservationId), JSON.stringify(holdsOf('rb')));
});

test('el historial viejo de producción que se recorta del log queda archivado (log-archive.jsonl)', async () => {
  const w = remeraWorld({ s: 5 });
  const t0 = Date.now() - 400 * 86400e3;
  const tag = 'arch-' + process.pid + '-' + Date.now();
  w.seed.productos[0].variantes[0].log = Array.from({ length: 1000 }, (_, i) => ({
    ts: new Date(t0 + i * 3600e3).toISOString(), action: 'sale', order_id: `${tag}-${i}`, delta: -1, stock: 5,
  })).reverse();
  await sc.reset(w);
  await sc.reserve('h', 1001, 1);
  assert.equal(sc.log('REMERA', 'var_s').length, 400);
  const fs = require('node:fs');
  const archive = path.join(path.dirname(sc.dbPath), 'log-archive.jsonl');
  const lines = fs.readFileSync(archive, 'utf8').split(/\r?\n/).filter(l => l.includes(tag));
  assert.equal(lines.length, 601, 'se archivan las 601 entradas recortadas, sin perder ninguna');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Errores de sync y links rotos
// ════════════════════════════════════════════════════════════════════════════
test('PUT fallido (500) → link.sync_error + alerta; el siguiente sync reintenta aunque el valor no cambie', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sc.syncVariante('REMERA', 'var_s', null, { force: true }); // cachea tn_stock = 5
  const restore = breakVariant(200, 2001);
  const r = await sc.syncVariante('REMERA', 'var_s', null, { force: true });
  assert.equal(r.ok, false);
  assert.ok(linkObj('REMERA', 'var_s', 2001).sync_error);
  assert.ok(!linkObj('REMERA', 'var_s', 1001).sync_error);
  const al = (await sc.alerts()).find(a => a.type === 'sync_error' && a.varianteId === 'var_s');
  assert.ok(al, 'falta alerta sync_error');
  restore();
  sc.tn.clearCalls();
  const r2 = await sc.syncVariante('REMERA', 'var_s'); // sin force, valor 5 = cache 5
  assert.equal(r2.ok, true);
  assert.equal(sc.tn.putsToVariant(2001).length, 1, 'reintenta el link con error');
  assert.equal(sc.tn.putsToVariant(1001).length, 0, 'no toca el que estaba bien');
  assert.ok(!linkObj('REMERA', 'var_s', 2001).sync_error);
  assert.ok(!(await sc.alerts()).some(a => a.type === 'sync_error' && a.varianteId === 'var_s'), 'la alerta se resuelve');
});

test('link a una variante borrada en TN: no tira el proceso, los demás links se actualizan, reconcile la marca', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const p = sc.tn.state.products.get(200);
  p.variants = p.variants.filter(v => v.id !== 2001);
  const r = await sc.reserve('d', 1001, 1);
  assert.equal(r.status, 200);
  await waitFor(() => linkObj('REMERA', 'var_s', 2001).sync_error, 5000).catch(() => {});
  await settle();
  assert.equal(sc.tn.getStock(1001), 5);
  assert.match(linkObj('REMERA', 'var_s', 2001).sync_error || '', /not exist|404|Not Found/i);
  assert.ok((await sc.alerts()).some(a => a.type === 'sync_error' && a.varianteId === 'var_s'));
  const rec = await sc.reconcileProducts();
  assert.equal(rec.faltantes, 1);
  assert.equal(linkObj('REMERA', 'var_s', 2001).missing_in_tn, true);
  // una venta por el link sano sigue funcionando
  await sc.process('order/created', sc.order([{ variant_id: 1001, quantity: 1 }]));
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  assert.equal((await sc.api('GET', '/api/health')).status, 200);
});

test('link marcado missing_in_tn no se re-PUTea en cada carrito', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const p = sc.tn.state.products.get(200);
  p.variants = p.variants.filter(v => v.id !== 2001);
  await sc.reconcileProducts();
  sc.tn.clearCalls();
  for (let i = 0; i < 3; i++) { await sc.reserve(`x${i}`, 1001, 1); await settle(); await sc.release(`x${i}`); await settle(); }
  assert.equal(sc.tn.putsToVariant(2001).length, 0, `PUTs al link muerto: ${sc.tn.putsToVariant(2001).length}`);
});

test('el botón "Sincronizar" de una variante corrige TN aunque la cache diga que está igual', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sc.syncVariante('REMERA', 'var_s', null, { force: true });
  sc.tn.setStock(2001, 99); // alguien lo editó a mano en TN
  const r = await sc.api('POST', '/api/productos/REMERA/variantes/var_s/sync');
  assert.equal(r.status, 200);
  assert.equal(sc.tn.getStock(2001), 5);
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Costo en llamadas a TN
// ════════════════════════════════════════════════════════════════════════════
const putPaths = () => sc.tn.callsTo('PUT', /^\/products\/\d+\/variants\/\d+$/).map(c => c.path);
async function primeBuzos(w) {
  await sc.reset(w, QUIET);
  for (const [p, v] of [['BUZO_CHANDLER', 'var_cs'], ['BUZO_CHANDLER', 'var_cm'], ['BUZO_MONICA', 'var_ms'], ['BUZO_MONICA', 'var_mm']]) {
    await sc.syncVariante(p, v, null, { force: true });
  }
  await settle();
  sc.tn.clearCalls();
}

test('[costo] con más de 3 libres un "agregar al carrito" no genera PUTs a TN', async () => {
  await primeBuzos(buzosWorld({ cs: 10, cm: 10, ms: 10, mm: 10 }));
  assert.equal((await sc.reserve('c', 3001, 1)).status, 200);
  await new Promise(r => setTimeout(r, 400)); await settle();
  assert.deepEqual(putPaths(), []);
  assert.equal((await sc.release('c')).body.released, 1);
  await new Promise(r => setTimeout(r, 400)); await settle();
  assert.deepEqual(putPaths(), []);
});

test('[costo] al cruzar el umbral (libre 4 → 3) se reparte exacto y PUTea los canales que cambian', async () => {
  await primeBuzos(buzosWorld({ cs: 4, cm: 10, ms: 10, mm: 10 }));
  assert.equal((await sc.reserve('c', 3001, 1)).status, 200); // CS libre 3
  await waitFor(() => putPaths().length >= 2, 5000).catch(() => {});
  await settle();
  assert.deepEqual(putPaths().sort(), ['/products/900/variants/9001', '/products/900/variants/9002']);
  assert.equal(sc.tn.getStock(3001), 4, 'el diseño del carrito conserva');
  assert.equal(sc.tn.getStock(9001), 3);
  sc.tn.clearCalls();
  await sc.release('c'); // vuelve a libre 4: todo el stock en todos los canales
  await waitFor(() => sc.tn.getStock(9001) === 4, 5000);
});

test('con más de 3 libres, otro diseño no debería ofrecer las unidades que están en carritos ajenos', { todo: 'BAJO: con libre > 3 channelStock devuelve stock total (no libre); una orden grande en otro diseño se come los carritos' }, async () => {
  await sc.reset(remeraWorld({ s: 10 }));
  for (let i = 0; i < 6; i++) assert.equal((await sc.reserve(`c${i}`, 1001, 1)).status, 200); // libre 4
  await sc.syncVariante('REMERA', 'var_s', null, { force: true });
  assert.ok(sc.tn.getStock(2001) <= 4, `2001 muestra ${sc.tn.getStock(2001)} con 4 libres y 6 en carritos de 1001`);
});

test('venta por un link marcado missing_in_tn (404 transitorio) debería actualizar ese canal en TN', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  await sc.syncVariante('REMERA', 'var_s', null, { force: true });
  linkObj('REMERA', 'var_s', 2001).missing_in_tn = true; // un 404 de TN que fue transitorio
  sc.db.write();
  sc.tn.clearCalls();
  await sc.process('order/created', sc.order([{ variant_id: 2001, quantity: 1 }])); // la orden prueba que existe
  assert.equal(sc.stock('REMERA', 'var_s'), 4);
  assert.equal(sc.tn.putsToVariant(2001).length, 1, 'no se PUTeó el canal vendido');
});

test('order/paid de una orden que ya figura cancelada en TN devuelve lo descontado (cancel perdido)', async () => {
  await sc.reset(remeraWorld({ s: 5 }));
  const oid = sc.order([{ variant_id: 1001, quantity: 2 }]);
  await sc.processOrderEvent('order/created', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 3);
  sc.tn.setOrder(oid, { status: 'cancelled' });
  await sc.processOrderEvent('order/paid', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
  await sc.processOrderEvent('order/created', oid);
  await sc.processOrderEvent('order/cancelled', oid);
  assert.equal(sc.stock('REMERA', 'var_s'), 5);
});

test('reservas rechazadas en ráfaga (endpoint público) no deberían generar un PUT a TN cada una', async () => {
  await sc.reset(remeraWorld({ s: 0 }));
  await sc.syncVariante('REMERA', 'var_s', null, { force: true });
  await settle();
  sc.tn.clearCalls();
  for (let i = 0; i < 10; i++) assert.equal((await sc.reserve(`bot${i}`, 1001, 1)).status, 409);
  await new Promise(r => setTimeout(r, 300)); await settle();
  const n = sc.tn.putsToVariant(1001).length;
  assert.ok(n <= 1, `${n} PUTs a 1001 por 10 requests anónimos (TN ya mostraba 0)`);
});

test('el script de storefront del repo llama al endpoint que existe (/api/reserve con variant_id)', async () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'public', 'storefront.js'), 'utf8');
  assert.match(src, /\/api\/reserve['/]/);
  assert.match(src, /variant_id/);
  const r = await sc.api('POST', '/api/reservations', { sessionId: 's', variantId: '1001', qty: 1 });
  assert.notEqual(r.status, 404);
});

// ════════════════════════════════════════════════════════════════════════════
// 8. ADMIN_TOKEN (proceso aparte: el token se lee al cargar server.js)
// ════════════════════════════════════════════════════════════════════════════
const AUTH_CHILD = `
  const fs = require('fs'), os = require('os'), path = require('path');
  for (const k of ['log','info','warn','error','debug']) console[k] = () => {};
  (async () => {
    const { createFakeTN } = require(${JSON.stringify(path.join(__dirname, 'fake-tn.js'))});
    const tn = createFakeTN(); await tn.listen();
    tn.addProduct({ id: 100, name: 'REMERA A', variants: [{ id: 1001, values: ['S'], stock: 5 }] });
    const dbPath = path.join(os.tmpdir(), 'sc-auth-' + process.pid + '.json');
    fs.writeFileSync(dbPath, JSON.stringify({ config: { access_token: 't', store_id: '1', webhook_registered: true },
      productos: [{ id: 'REMERA', nombre: 'Remera', variantes: [{ id: 'var_s', label: 'S', stock: 5, links: [{ product_id: '100', variant_id: '1001', label: 'A S' }], log: [] }] }],
      reservations: [], matchs: [] }));
    Object.assign(process.env, { DB_PATH: dbPath, TN_API_BASE: tn.url, TN_THROTTLE: 'off', ADMIN_TOKEN: 'tok-123' });
    const sc = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const srv = sc.app.listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const st = async (m, p, h = {}, b) => (await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b && JSON.stringify(b) })).status;
    const out = {
      noToken: await st('GET', '/api/productos'),
      badToken: await st('GET', '/api/productos', { Authorization: 'Bearer nope' }),
      withToken: await st('GET', '/api/productos', { Authorization: 'Bearer tok-123' }),
      queryToken: await st('GET', '/api/alerts?token=tok-123'),
      reserve: await st('POST', '/api/reserve', {}, { sessionId: 'pub', variant_id: '1001', qty: 1 }),
      release: await st('DELETE', '/api/reserve/pub'),
      health: await st('GET', '/api/health'),
      configNoToken: await st('POST', '/api/config', {}, { access_token: 'x', store_id: '2' }),
      upperNoToken: await st('GET', '/API/productos'),
      slashNoToken: await st('GET', '/api/productos/'),
      mixedNoToken: await st('GET', '/Api/Productos?x=1'),
      doubleSlash: await st('GET', '//api/productos'),
      upperConfig: await st('POST', '/Api/config', {}, { access_token: 'robado', store_id: '666' }),
      storeAfter: JSON.parse(fs.readFileSync(dbPath, 'utf8')).config.store_id,
    };
    process.stdout.write('RESULT' + JSON.stringify(out));
    srv.close(); await tn.close(); try { fs.unlinkSync(dbPath); } catch (_) {}
    process.exit(0);
  })().catch(e => { process.stdout.write('ERROR' + e.stack); process.exit(1); });
`;
let authResult = null;
async function runAuthChild() {
  if (authResult) return authResult;
  const env = { ...process.env }; delete env.ADMIN_TOKEN;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', AUTH_CHILD], { env, timeout: 30000 }, (err, out) => (err ? reject(new Error(`${err.message}\n${out}`)) : resolve(out)));
  });
  const i = stdout.indexOf('RESULT');
  if (i < 0) throw new Error(stdout);
  authResult = JSON.parse(stdout.slice(i + 6));
  return authResult;
}

test('ADMIN_TOKEN: /api/productos sin token 401, con token 200; reservas y health siguen públicos', async () => {
  const r = await runAuthChild();
  assert.equal(r.noToken, 401);
  assert.equal(r.badToken, 401);
  assert.equal(r.withToken, 200);
  assert.equal(r.queryToken, 200);
  assert.equal(r.reserve, 200);
  assert.equal(r.release, 200);
  assert.equal(r.health, 200);
  assert.equal(r.configNoToken, 401);
});

test('ADMIN_TOKEN: /API/..., /Api/..., barra final no saltean la auth', async () => {
  const r = await runAuthChild();
  assert.ok([r.slashNoToken, r.mixedNoToken, r.doubleSlash].every(x => x === 401 || x === 404), JSON.stringify(r));
  assert.deepEqual({ get: r.upperNoToken, config: r.upperConfig }, { get: 401, config: 401 },
    `GET /API/productos → ${r.upperNoToken}; POST /Api/config → ${r.upperConfig} (store_id quedó "${r.storeAfter}")`);
});
