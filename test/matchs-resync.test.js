'use strict';
// j. resyncAllMatchs / repairAllMatchVariants contra el TN falso
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buzosWorld } = require('./helpers');

let sc;
before(async () => { sc = await startServer(buzosWorld()); });
after(async () => { await sc.close(); });

const QUIET = { quietMs: 900 };

test('resyncAllMatchs: contenedor = min(individual1, individual2) por combo', { timeout: 30000 }, async () => {
  await sc.reset(buzosWorld({ cs: 3, cm: 2, ms: 2, mm: 0, container: 99 }), QUIET);
  const r = await sc.resyncAllMatchs();
  assert.equal(r.total_matchs, 1);
  assert.equal(r.total_updated, 4);
  assert.equal(r.results[0].error, undefined);
  assert.equal(sc.tn.getStock(9001), 2); // min(3, 2)
  assert.equal(sc.tn.getStock(9002), 0); // min(3, 0)
  assert.equal(sc.tn.getStock(9003), 2); // min(2, 2)
  assert.equal(sc.tn.getStock(9004), 0); // min(2, 0)
});

test('resyncAllMatchs: match sin variantMap se saltea', { timeout: 30000 }, async () => {
  const w = buzosWorld();
  w.seed.matchs.push({ id: 'match_roto', nombre: 'ROTO', producto1: { tn_product_id: '300' }, producto2: { tn_product_id: '400' } });
  await sc.reset(w, QUIET);
  const r = await sc.resyncAllMatchs();
  assert.equal(r.total_matchs, 2);
  assert.ok(r.results.find(x => x.id === 'match_roto').skipped);
});

test('resyncAllMatchs: lado NO gestionado en SC cuyo producto no existe en TN → error en ese match, no revienta', { timeout: 30000 }, async () => {
  const w = buzosWorld();
  // MONICA no está dada de alta en SC y además su producto no existe en TN
  w.seed.productos = w.seed.productos.filter(p => p.id !== 'BUZO_MONICA');
  w.tnProducts = w.tnProducts.filter(p => p.id !== 400);
  await sc.reset(w, QUIET);
  const r = await sc.resyncAllMatchs();
  const res = r.results[0];
  assert.ok(res.error || (res.errors && res.errors.length), 'debería reportar error en el match');
});

test('resyncAllMatchs: con los dos lados gestionados no depende del stock de los individuales en TN', { timeout: 30000 }, async () => {
  const w = buzosWorld({ cs: 3, cm: 2, ms: 2, mm: 0, container: 9 });
  w.tnProducts = w.tnProducts.filter(p => p.id !== 400); // aunque el individual falte en TN
  await sc.reset(w, QUIET);
  const r = await sc.resyncAllMatchs();
  assert.ok(!r.results[0].error);
  assert.equal(sc.tn.getStock(9001), 2); // min(SC 3, SC 2)
  assert.equal(sc.tn.getStock(9002), 0);
});

test('repairAllMatchVariants: agrega al contenedor las combinaciones faltantes', { timeout: 30000 }, async () => {
  const w = buzosWorld({ cs: 3, cm: 2, ms: 2, mm: 0 });
  // talle nuevo L en CHANDLER, que el contenedor todavía no tiene
  w.tnProducts.find(p => p.id === 300).variants.push({ id: 3003, values: ['L'], stock: 4 });
  await sc.reset(w, QUIET);
  sc.tn.clearCalls();

  const r = await sc.repairAllMatchVariants();
  assert.equal(r.total_missing, 2);
  assert.equal(r.total_added, 2);
  assert.equal(r.total_failed, 0);

  const posts = sc.tn.callsTo('POST', '/products/900/variants');
  assert.equal(posts.length, 2);

  const container = sc.tn.getProduct(900);
  assert.equal(container.variants.length, 6);

  const vm = sc.match('match_1').variantMap;
  assert.equal(vm.length, 6);
  const nuevos = vm.filter(x => x.v1id === '3003');
  assert.deepEqual(nuevos.map(x => x.v2id).sort(), ['4001', '4002']);
  for (const n of nuevos) {
    const tnVar = sc.tn.getVariant(n.tn_variant_id);
    assert.ok(tnVar, `la variante ${n.tn_variant_id} debería existir en el contenedor`);
    assert.equal(tnVar.product_id, 900);
    assert.equal(tnVar.stock, n.v2id === '4001' ? 2 : 0); // min(4, 2) y min(4, 0)
    assert.equal(tnVar.values.length, 2);
    assert.match(tnVar.values[0].es, /^L/);
  }
});

test('repairAllMatchVariants: sin faltantes no crea nada', { timeout: 30000 }, async () => {
  await sc.reset(buzosWorld(), QUIET);
  sc.tn.clearCalls();
  const r = await sc.repairAllMatchVariants();
  assert.equal(r.total_missing, 0);
  assert.equal(r.total_added, 0);
  assert.equal(sc.tn.callsTo('POST', /variants$/).length, 0);
});

test('syncMatchStock: lado no gestionado con stock null (infinito) en TN → usa el otro lado', { timeout: 30000 }, async () => {
  const w = buzosWorld({ container: 99 });
  w.seed.productos = w.seed.productos.filter(p => p.id !== 'BUZO_MONICA');
  w.tnProducts.find(p => p.id === 400).variants.find(v => v.id === 4001).stock = null;
  await sc.reset(w, QUIET);
  const r = await sc.syncMatchStock('match_1');
  assert.equal(r.ok, true);
  assert.equal(sc.tn.getStock(9001), 3); // min(3, ∞)
  assert.equal(sc.tn.getStock(9002), 0); // min(3, 0)
});
